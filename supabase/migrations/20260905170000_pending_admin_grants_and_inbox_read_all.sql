-- 1. Назначение администратора по почте до регистрации.
--
-- set_product_role_by_email отвечал USER_NOT_FOUND, если человек ещё ни разу
-- не входил. Теперь для незнакомой почты сохраняется отложенное назначение:
-- при первом входе с этой почтой аккаунт сразу становится администратором
-- (со строкой role.changed в истории от имени назначившего). Отложенное
-- назначение видно в списке и отменяется той же RPC с ролью participant.
--
-- 2. «Прочитать всё» для инбокса уведомлений.
--
-- Бейдж считает непрочитанные по всем событиям, а прочитать можно было только
-- видимые. Событие, которое контракт приложения пропускает, застревало
-- непрочитанным навсегда («фантомная 1»). Новая RPC ставит отметку
-- прочитанности на все события разом.

create table private.pending_admin_grants (
  normalized_email text primary key,
  granted_by uuid references auth.users(id) on delete set null,
  reason text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint pending_admin_grant_email_shape check (
    char_length(normalized_email) between 3 and 254
    and normalized_email = lower(btrim(normalized_email))
    and normalized_email ~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    and normalized_email not like '%@auth.invalid'
  ),
  constraint pending_admin_grant_reason_shape check (
    char_length(reason) between 10 and 500
  )
);

alter table private.pending_admin_grants enable row level security;
revoke all on table private.pending_admin_grants
  from public, anon, authenticated, service_role;

-- Первый вход: обычные строки нового аккаунта плюс применение отложенного
-- назначения администратора, если оно ждало эту почту.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grant private.pending_admin_grants%rowtype;
  v_email text := lower(btrim(coalesce(new.email::text, '')));
begin
  insert into public.profiles (id, name, surname, job)
  values (
    new.id,
    private.normalize_profile_text(new.raw_user_meta_data ->> 'name'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'surname'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'job')
  );
  insert into public.user_roles (user_id) values (new.id);
  insert into public.account_controls (user_id, approval_state)
  values (new.id, 'profile_incomplete');
  insert into public.verified_identities (user_id) values (new.id);

  if v_email <> '' and v_email not like '%@auth.invalid' then
    select * into v_grant
    from private.pending_admin_grants grant_row
    where grant_row.normalized_email = v_email
    for update;
    if found then
      perform set_config('safetyhub.skip_role_audit', '1', true);
      update public.user_roles
      set role = 'admin'::public.app_role,
          product_role = 'admin'::public.product_role,
          created_by = v_grant.granted_by
      where user_id = new.id;
      insert into public.admin_audit_log (
        actor_user_id, target_user_id, action, target_type, target_id,
        before_data, after_data, reason
      ) values (
        v_grant.granted_by, new.id, 'role.changed', 'user', new.id::text,
        jsonb_build_object('productRole', 'participant'),
        jsonb_build_object('productRole', 'admin', 'appliedFrom', 'pending_admin_grant'),
        v_grant.reason
      );
      delete from private.pending_admin_grants
      where normalized_email = v_email;
      perform set_config('safetyhub.skip_role_audit', '', true);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function private.handle_new_user()
  from public, anon, authenticated, service_role;

-- По незнакомой почте назначение админа откладывается вместо отказа; роль
-- participant по незнакомой почте отменяет отложенное назначение.
create or replace function public.set_product_role_by_email(
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
  if v_email like '%@auth.invalid' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_INVALID';
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
    if p_role = 'admin' then
      insert into private.pending_admin_grants (normalized_email, granted_by, reason)
      values (v_email, v_actor_id, btrim(p_reason))
      on conflict (normalized_email) do update
      set granted_by = excluded.granted_by,
          reason = excluded.reason,
          created_at = statement_timestamp();
      v_result := jsonb_build_object(
        'email', v_email, 'role', 'admin', 'pending', true, 'changed', true
      );
    else
      delete from private.pending_admin_grants
      where normalized_email = v_email;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
      end if;
      v_result := jsonb_build_object(
        'email', v_email, 'role', 'participant', 'pending', false, 'changed', true
      );
    end if;
  else
    v_result := private.apply_product_role_change(
      v_actor_id, v_target_id, p_role, p_reason, p_idempotency_key
    );
  end if;

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, 'role', v_request_hash, v_result
  );

  return private.ensure_rpc_payload(v_result);
end;
$$;

create function public.list_pending_admin_grants()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('role.manage');
  v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
    'email', grant_row.normalized_email,
    'reason', grant_row.reason,
    'createdAt', grant_row.created_at
  ) order by grant_row.created_at desc, grant_row.normalized_email), '[]'::jsonb)
  into v_items
  from private.pending_admin_grants grant_row;
  return jsonb_build_object('items', v_items);
end;
$$;

revoke all on function public.list_pending_admin_grants()
  from public, anon, authenticated, service_role;
grant execute on function public.list_pending_admin_grants() to authenticated;

comment on function public.list_pending_admin_grants() is
  'Pending administrator appointments by email, visible to role.manage operators.';

-- «Прочитать всё»: отметка на каждом событии, включая те, что приложение не
-- может отрисовать. Ровно тот же контракт доступа, что и у остального инбокса.
create function public.mark_all_admin_notifications_read()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_any_capability(
    array['notifications.read', 'audit.read']
  );
  v_count integer;
begin
  insert into private.admin_notification_reads(admin_user_id, event_id)
  select v_actor_id, event.id
  from private.notification_events event
  on conflict (admin_user_id, event_id) do nothing;
  get diagnostics v_count = row_count;
  return jsonb_build_object('marked', v_count);
end;
$$;

revoke all on function public.mark_all_admin_notifications_read()
  from public, anon, authenticated, service_role;
grant execute on function public.mark_all_admin_notifications_read() to authenticated;
