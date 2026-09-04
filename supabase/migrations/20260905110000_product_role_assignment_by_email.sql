-- Let an administrator appoint another administrator by email address.
--
-- Role editing was removed from the product and the older RPCs were revoked
-- from every role including `service_role`, which left `npm run admin:bootstrap`
-- on a developer machine as the only way to grant access. This migration adds
-- one narrow, reasoned, idempotent operation instead of bringing back the old
-- per-capability matrix: two product roles, an email address, a written reason,
-- an audit row, and refusals for the cases that would lock the product.
--
-- `manage_user_role_confirmed` and `set_user_capabilities_confirmed` stay
-- revoked from everyone.

create function private.apply_product_role_change(
  p_actor_id uuid,
  p_target_id uuid,
  p_role public.product_role,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_legacy_role public.app_role;
  v_old_role public.product_role;
  v_status public.account_status;
  v_deletion_pending boolean;
  v_approval public.account_approval_state;
begin
  if p_target_id = p_actor_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'CANNOT_CHANGE_OWN_ROLE';
  end if;
  -- Synthetic Chinese logins have an unroutable `@auth.invalid` address; they
  -- must never be addressable by email nor become operators.
  if private.is_zh_synthetic_user(p_target_id) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_INVALID';
  end if;

  select role.role, role.product_role, control.status,
         control.deletion_pending, control.approval_state
  into v_legacy_role, v_old_role, v_status, v_deletion_pending, v_approval
  from public.user_roles role
  join public.account_controls control on control.user_id = role.user_id
  where role.user_id = p_target_id
  for update of role, control;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if v_status <> 'active' or v_deletion_pending then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACCOUNT_UNAVAILABLE';
  end if;
  -- Admin access is independent of learner admission: an operator who never
  -- enrolled on a course sits at `profile_incomplete` forever, and requiring
  -- `approved` here would make the whole screen unusable. Only an account that
  -- was explicitly turned down is refused.
  if p_role = 'admin' and v_approval = 'rejected' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'TARGET_REJECTED';
  end if;

  if v_old_role = p_role then
    return jsonb_build_object(
      'userId', p_target_id, 'role', p_role, 'previousRole', v_old_role, 'changed', false
    );
  end if;

  if p_role = 'participant' then
    -- The legacy superadmin row is what `assert_active_superadmin_invariant`
    -- protects; demoting it would surface as a trigger failure instead of an
    -- explainable refusal.
    if v_legacy_role = 'superadmin' then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'SUPERADMIN_DEMOTION_FORBIDDEN';
    end if;
    if not exists (
      select 1
      from public.user_roles role
      join public.account_controls control on control.user_id = role.user_id
      where role.product_role = 'admin'
        and control.status = 'active'
        and not control.deletion_pending
        and role.user_id <> p_target_id
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'LAST_ACTIVE_ADMIN_PROTECTED';
    end if;
  end if;

  -- Both columns move together. `user_roles_sync_product_role` derives
  -- `product_role` from the legacy `role` on any update that touches it, so
  -- writing only one of them would let a later unrelated write silently restore
  -- the old access level.
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles
  set role = case when p_role = 'admin'
               then 'admin'::public.app_role
               else 'user'::public.app_role end,
      product_role = p_role,
      created_by = p_actor_id
  where user_id = p_target_id;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason, batch_id
  ) values (
    p_actor_id, p_target_id, 'role.changed', 'user', p_target_id::text,
    jsonb_build_object('productRole', v_old_role, 'legacyRole', v_legacy_role),
    jsonb_build_object('productRole', p_role),
    btrim(p_reason), p_idempotency_key
  );

  return jsonb_build_object(
    'userId', p_target_id, 'role', p_role, 'previousRole', v_old_role, 'changed', true
  );
end;
$$;

revoke all on function private.apply_product_role_change(
  uuid,uuid,public.product_role,text,uuid
) from public, anon, authenticated, service_role;

create function private.begin_product_role_operation(
  p_actor_id uuid,
  p_idempotency_key uuid,
  p_target_key text,
  p_role public.product_role,
  p_reason text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_hash text;
  v_receipt private.admin_operation_receipts%rowtype;
begin
  if p_idempotency_key is null or p_role is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INVALID_ROLE_OPERATION';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'ROLE_REASON_REQUIRED';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'action', 'role',
      'target', p_target_key,
      'role', p_role,
      'reason', p_reason
    )::text,
    'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    p_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));

  select * into v_receipt
  from private.admin_operation_receipts receipt
  where receipt.actor_user_id = p_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return null;
  end if;

  perform private.enforce_actor_quota('admin.access.mutate');
  perform private.lock_active_superadmin_invariant();
  return v_request_hash;
end;
$$;

revoke all on function private.begin_product_role_operation(
  uuid,uuid,text,public.product_role,text
) from public, anon, authenticated, service_role;

create function public.set_product_role_by_email(
  p_idempotency_key uuid,
  p_email text,
  p_role public.product_role,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('role.manage');
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_request_hash text;
  v_target_id uuid;
  v_result jsonb;
begin
  if char_length(v_email) not between 3 and 254
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception using errcode = 'invalid_parameter_value', message = 'EMAIL_INVALID';
  end if;

  v_request_hash := private.begin_product_role_operation(
    v_actor_id, p_idempotency_key, v_email, p_role, p_reason
  );
  if v_request_hash is null then
    select receipt.result || jsonb_build_object('replayed', true) into v_result
    from private.admin_operation_receipts receipt
    where receipt.actor_user_id = v_actor_id
      and receipt.idempotency_key = p_idempotency_key;
    return v_result;
  end if;

  select auth_user.id into v_target_id
  from auth.users auth_user
  where lower(btrim(auth_user.email::text)) = v_email
    and auth_user.deleted_at is null
  order by auth_user.created_at, auth_user.id
  limit 1;
  if v_target_id is null then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;

  v_result := private.apply_product_role_change(
    v_actor_id, v_target_id, p_role, p_reason, p_idempotency_key
  );

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, 'role', v_request_hash, v_result
  );

  return private.ensure_rpc_payload(v_result);
end;
$$;

create function public.set_product_role_by_user_id(
  p_idempotency_key uuid,
  p_target_id uuid,
  p_role public.product_role,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('role.manage');
  v_request_hash text;
  v_result jsonb;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'USER_ID_REQUIRED';
  end if;

  v_request_hash := private.begin_product_role_operation(
    v_actor_id, p_idempotency_key, p_target_id::text, p_role, p_reason
  );
  if v_request_hash is null then
    select receipt.result || jsonb_build_object('replayed', true) into v_result
    from private.admin_operation_receipts receipt
    where receipt.actor_user_id = v_actor_id
      and receipt.idempotency_key = p_idempotency_key;
    return v_result;
  end if;

  v_result := private.apply_product_role_change(
    v_actor_id, p_target_id, p_role, p_reason, p_idempotency_key
  );

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, 'role', v_request_hash, v_result
  );

  return private.ensure_rpc_payload(v_result);
end;
$$;

create function private.list_admin_operators_page_provider_internal(
  p_limit integer default 25,
  p_query text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('role.manage');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INVALID_ADMIN_OPERATORS_CURSOR';
  end if;

  with base_filtered as (
    select auth_user.id,
      coalesce(auth_user.email::text, '') as email,
      coalesce(
        nullif(btrim(concat_ws(' ', profile.name, profile.surname)), ''),
        auth_user.email::text,
        auth_user.id::text
      ) as label,
      profile.created_at,
      auth_user.id = v_actor_id as is_self,
      role.role = 'superadmin' as protected
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.user_roles role on role.user_id = auth_user.id
    join public.account_controls control on control.user_id = auth_user.id
    where auth_user.deleted_at is null
      and role.product_role = 'admin'
      and control.status = 'active'
      and not control.deletion_pending
      and (v_query is null
        or lower(coalesce(auth_user.email::text, '')) like '%' || v_query || '%'
        or private.normalized_lookup_key(
          concat_ws(' ', profile.name, profile.surname)
        ) like '%' || v_query || '%')
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id)
        < (p_cursor_created_at, p_cursor_id)
  ), ordered as (
    select filtered.*
    from filtered
    order by filtered.created_at desc, filtered.id desc
    limit v_limit + 1
  ), page as (
    select ordered.*
    from ordered
    order by ordered.created_at desc, ordered.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'email', page.email,
      'label', page.label,
      'createdAt', page.created_at,
      'isSelf', page.is_self,
      'protected', page.protected
    ) order by page.created_at desc, page.id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object('at', last.created_at, 'id', last.id)
      from page last order by last.created_at, last.id limit 1)
  into v_items, v_total, v_more, v_next
  from page;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_more,
    'nextCursor', case when v_more then v_next else null end
  );
end;
$$;

create function public.list_admin_operators_page(
  p_limit integer default 25,
  p_query text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.redact_zh_email_items(
    private.list_admin_operators_page_provider_internal(
      p_limit, p_query, p_cursor_created_at, p_cursor_id
    )
  );
$$;

revoke all on function private.list_admin_operators_page_provider_internal(
  integer,text,timestamp with time zone,uuid
) from public, anon, authenticated, service_role;

revoke execute on function public.set_product_role_by_email(
  uuid,text,public.product_role,text
) from public, anon, service_role;
grant execute on function public.set_product_role_by_email(
  uuid,text,public.product_role,text
) to authenticated;

revoke execute on function public.set_product_role_by_user_id(
  uuid,uuid,public.product_role,text
) from public, anon, service_role;
grant execute on function public.set_product_role_by_user_id(
  uuid,uuid,public.product_role,text
) to authenticated;

revoke all on function public.list_admin_operators_page(
  integer,text,timestamp with time zone,uuid
) from public, anon, service_role;
grant execute on function public.list_admin_operators_page(
  integer,text,timestamp with time zone,uuid
) to authenticated;

comment on function public.set_product_role_by_email(uuid,text,public.product_role,text) is
  'Reasoned, idempotent two-role assignment by verified email for a role.manage administrator.';
comment on function public.list_admin_operators_page(integer,text,timestamp with time zone,uuid) is
  'Cursor page of active administrators for the operator screen.';
