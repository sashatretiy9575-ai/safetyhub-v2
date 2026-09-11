-- Self-service account deletion that finishes inside the request.
--
-- `DELETE /api/profile/account` used to call `begin_user_account_purge`, which
-- only marks `deletion_pending` and leaves the actual removal to the
-- `storage-reconciler` Edge Function. That function has no schedule, so a
-- person who deleted their account kept an auth user forever: a later sign-in
-- with the same email verified fine and then every profile RPC refused the
-- account (`ACCOUNT_UNAVAILABLE`), which the login screen reported as
-- "session confirmed, profile unavailable, try later" — forever.
--
-- The owner's decision: a self-deletion removes everything at once, and a new
-- sign-in with the same email starts a brand-new account. The administrator
-- path (`admin_purge_user_accounts`) already performs the purge in one
-- transaction; this migration lets the same worker run for the account owner
-- (no actor, its own audit event) and adds a sweep that finishes any
-- self-deletion the staged path left pending before an OTP is sent to that
-- email. The staged functions stay untouched for the reconciler and the
-- hosted security gates.

-- 1. Белый список событий: добавлено самостоятельное удаление, завершённое сразу.
create or replace function private.audit_event_allowed(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_action in (
    -- (a) регистрация прошла и администратор подтвердил — одно событие
    'account.approval.approved',
    -- (b) тест пройден
    'test.passed',
    -- (c) сертификат выдан
    'certificate.issued',
    -- (d) пользователь удалил свою учётную запись
    'user.self_delete_requested',
    -- (e) администратор удалил учётную запись
    'user.purged',
    -- (e2) пользователь сам удалил учётную запись — удаление завершено сразу
    'user.self_purged',
    -- (f) назначение администратора (все пути назначения)
    'role.changed',
    'role.changed_directly',
    'admin.provisioned_by_email',
    'superadmin.bootstrapped',
    'admin.break_glass_restored'
  );
$$;


-- 2. The immediate purge worker accepts a null actor (the owner) and records
-- the self-service event under its own name; the administrator path is
-- byte-for-byte what it was.
create or replace function private.purge_user_account_immediate(
  p_actor_id uuid,
  p_target_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_status public.account_status;
  v_deletion_pending boolean;
  v_product_role public.product_role;
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
  v_operation_ids uuid[];
begin
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id and auth_user.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ALREADY_ABSENT'
    );
  end if;

  select control.status, control.deletion_pending
  into v_status, v_deletion_pending
  from public.account_controls control
  where control.user_id = p_target_id
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'USER_NOT_FOUND'
    );
  end if;

  select role.product_role into v_product_role
  from public.user_roles role
  where role.user_id = p_target_id
  for update;

  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped',
      'reason', 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS'
    );
  end if;

  -- The only other `on delete restrict` reference to auth.users besides the
  -- outbox. Without this check the delete surfaces as a raw foreign key error.
  if exists (
    select 1 from private.initial_course_import_operations operation
    where operation.created_by = p_target_id
  ) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ACCOUNT_HAS_IMPORT_RECEIPT'
    );
  end if;

  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id;

  insert into private.account_storage_cleanup_tombstones (
    user_id, storage_prefix, requested_at, cleanup_not_before, next_attempt_at
  ) values (
    p_target_id, p_target_id::text || '/',
    statement_timestamp(), statement_timestamp(), statement_timestamp()
  ) on conflict (user_id) do nothing;

  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      last_error_code = 'ACCOUNT_DELETION_REQUESTED'
  where user_id = p_target_id
    and state in ('prepared', 'staged', 'reconcile_required');

  -- `account_storage_cleanup_times` requires the cleared timestamps to be at or
  -- after `cleanup_not_before`, so a tombstone left over from the staged path
  -- has its horizon pulled back to now before the state advances.
  update private.account_storage_cleanup_tombstones
  set cleanup_not_before = least(cleanup_not_before, statement_timestamp()),
      state = 'storage_cleared',
      empty_confirmed_at = statement_timestamp(),
      storage_cleared_at = statement_timestamp(),
      auth_purged_at = null,
      db_purged_at = null,
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp(),
      last_error_code = null
  where user_id = p_target_id
  returning * into v_tombstone;
  if v_tombstone.id is null then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'TOMBSTONE_MISSING'
    );
  end if;

  update private.avatar_upload_operations
  set state = case when state = 'committed' then state else 'aborted' end,
      finalized_at = coalesce(finalized_at, statement_timestamp()),
      artifacts_cleared_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where user_id = p_target_id;

  select coalesce(array_agg(operation.id order by operation.id), '{}'::uuid[])
  into v_operation_ids
  from private.auth_admin_outbox operation
  where operation.actor_user_id = p_target_id
    or operation.target_id = p_target_id
    or (
      operation.operation_type in ('suspend', 'restore')
      and operation.payload ->> 'targetId' = p_target_id::text
    )
    or (
      operation.operation_type = 'invite'
      and lower(btrim(operation.payload ->> 'email')) = v_email
    );

  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  perform set_config('safetyhub.storage_purge_user_id', p_target_id::text, true);
  perform set_config(
    'safetyhub.purge_operation_ids',
    array_to_string(v_operation_ids, ','),
    true
  );

  update public.test_revisions
  set published_by = null
  where published_by = p_target_id;
  update public.certificates
  set issued_by = case when issued_by = p_target_id then null else issued_by end,
      revoked_by = case when revoked_by = p_target_id then null else revoked_by end
  where issued_by = p_target_id or revoked_by = p_target_id;

  delete from public.admin_audit_log audit
  where audit.actor_user_id = p_target_id
    or audit.target_user_id = p_target_id
    or (
      audit.target_type = 'auth_admin_operation'
      and audit.target_id = any(
        array(select operation_id::text from unnest(v_operation_ids) operation_id)
      )
    );
  delete from private.auth_admin_outbox operation
  where operation.id = any(v_operation_ids);
  delete from private.avatar_upload_operations operation
  where operation.user_id = p_target_id;
  delete from private.profile_avatar_manifests manifest
  where manifest.user_id = p_target_id;
  delete from private.signup_legal_operations operation
  where operation.completed_user_id = p_target_id
    or operation.normalized_email = v_email;
  delete from auth.users where id = p_target_id;

  update private.account_storage_cleanup_tombstones
  set state = 'post_purge_cleanup',
      auth_purged_at = statement_timestamp(),
      empty_confirmed_at = null,
      next_attempt_at = statement_timestamp() + interval '15 minutes',
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where id = v_tombstone.id;

  -- Written after the delete on purpose: the statements above remove every
  -- audit row that references the target, so an entry inserted earlier would be
  -- erased along with them. `target_user_id` must stay null because the column
  -- is a foreign key to the row that no longer exists, and no personal data of
  -- the deleted account is recorded here — retaining it would defeat the
  -- deletion this row is describing.
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, reason, batch_id
  ) values (
    p_actor_id, null,
    case when p_actor_id is null then 'user.self_purged' else 'user.purged' end,
    'user', p_target_id::text,
    jsonb_build_object(
      'productRole', v_product_role,
      'accountStatus', v_status,
      'deletionAlreadyPending', v_deletion_pending
    ),
    btrim(p_reason), p_idempotency_key
  );

  -- The GUCs stay set for the rest of the transaction otherwise, and would keep
  -- authorizing audit deletions for this identifier while later targets run.
  perform set_config('safetyhub.purge_actor_id', '', true);
  perform set_config('safetyhub.storage_purge_user_id', '', true);
  perform set_config('safetyhub.purge_operation_ids', '', true);

  return jsonb_build_object('id', p_target_id, 'status', 'completed', 'reason', null);
end;
$$;


-- 3. The owner's own purge. Service-role only: the route authenticates the
-- owner and passes their id, exactly like the staged entry point did.
create function public.self_purge_user_account(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item jsonb;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'USER_ID_REQUIRED';
  end if;

  -- Same order as the staged purge functions; changing it would deadlock
  -- against the reconciler and against the Auth outbox finalizer.
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  perform private.lock_signup_legal_operations();

  if not exists (
    select 1 from auth.users auth_user
    where auth_user.id = p_target_id and auth_user.deleted_at is null
  ) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ALREADY_ABSENT'
    );
  end if;

  -- The last active administrator cannot remove themselves: the workspace
  -- would have nobody left to approve accounts or issue certificates.
  if exists (
    select 1 from public.user_roles role
    where role.user_id = p_target_id and role.product_role = 'admin'
  ) and not exists (
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

  v_item := private.purge_user_account_immediate(
    null, p_target_id, 'self-service account deletion', gen_random_uuid()
  );
  return v_item;
end;
$$;

revoke execute on function public.self_purge_user_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.self_purge_user_account(uuid) to service_role;

-- 4. Finishes a self-deletion the staged path left pending, by email, so the
-- sign-in that follows creates a brand-new account instead of reviving the
-- old one. Only accounts already marked `deletion_pending` are touched: the
-- owner asked for exactly this, and the mark is set by nothing else.
create function public.purge_pending_self_deletion(p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_user_id uuid;
begin
  if v_email = '' then
    return jsonb_build_object('purged', false, 'reason', 'EMAIL_REQUIRED');
  end if;

  select auth_user.id into v_user_id
  from auth.users auth_user
  join public.account_controls control on control.user_id = auth_user.id
  where lower(btrim(auth_user.email)) = v_email
    and auth_user.deleted_at is null
    and control.deletion_pending
  order by auth_user.created_at
  limit 1;
  if v_user_id is null then
    return jsonb_build_object('purged', false, 'reason', 'NOTHING_PENDING');
  end if;

  return public.self_purge_user_account(v_user_id)
    || jsonb_build_object('purged', true);
end;
$$;

revoke execute on function public.purge_pending_self_deletion(text)
  from public, anon, authenticated, service_role;
grant execute on function public.purge_pending_self_deletion(text) to service_role;
