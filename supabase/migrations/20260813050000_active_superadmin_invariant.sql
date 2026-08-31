-- Preserve at least one usable superadmin, not merely one role row.
--
-- Every transition that can affect the invariant uses the same transaction
-- advisory lock.  The table triggers are the final guard for service-role
-- maintenance and cascades; supported RPCs acquire the lock before their DML.

create function private.lock_active_superadmin_invariant()
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  select pg_advisory_xact_lock(
    hashtextextended('safetyhub:superadmin-role', 0)
  );
$$;

create function private.assert_active_superadmin_invariant()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.user_roles role_row
    join public.account_controls control
      on control.user_id = role_row.user_id
    where role_row.role = 'superadmin'
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using
      errcode = 'object_not_in_prerequisite_state',
      message = 'LAST_ACTIVE_SUPERADMIN_PROTECTED';
  end if;
end;
$$;

revoke all on function private.lock_active_superadmin_invariant()
  from public, anon, authenticated, service_role;
revoke all on function private.assert_active_superadmin_invariant()
  from public, anon, authenticated, service_role;

create function private.guard_active_superadmin_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_affects_invariant boolean;
begin
  v_affects_invariant := case tg_op
    when 'INSERT' then new.role = 'superadmin'
    when 'DELETE' then old.role = 'superadmin'
    else old.role = 'superadmin' or new.role = 'superadmin'
  end;

  if v_affects_invariant then
    perform private.lock_active_superadmin_invariant();
    if tg_when = 'AFTER' then
      perform private.assert_active_superadmin_invariant();
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create function private.guard_active_superadmin_control()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  v_affects_invariant boolean;
begin
  select exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = v_user_id
      and role_row.role = 'superadmin'
  ) into v_affects_invariant;

  if v_affects_invariant then
    perform private.lock_active_superadmin_invariant();
    if tg_when = 'AFTER' then
      perform private.assert_active_superadmin_invariant();
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function private.guard_active_superadmin_role()
  from public, anon, authenticated, service_role;
revoke all on function private.guard_active_superadmin_control()
  from public, anon, authenticated, service_role;

create trigger user_roles_active_superadmin_before
before insert or update or delete on public.user_roles
for each row execute function private.guard_active_superadmin_role();

create trigger user_roles_active_superadmin_after
after insert or update or delete on public.user_roles
for each row execute function private.guard_active_superadmin_role();

create trigger account_controls_active_superadmin_before
before insert or update or delete on public.account_controls
for each row execute function private.guard_active_superadmin_control();

create trigger account_controls_active_superadmin_after
after insert or update or delete on public.account_controls
for each row execute function private.guard_active_superadmin_control();

-- Suspension and restore are committed asynchronously by this service-only
-- finalizer.  Acquire the invariant lock before the inner function changes an
-- account status; the table trigger performs the post-condition check.
alter function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  rename to advance_auth_admin_operation_invariant_inner;
alter function public.advance_auth_admin_operation_invariant_inner(uuid,text,text,uuid,text)
  set schema private;
revoke all on function private.advance_auth_admin_operation_invariant_inner(uuid,text,text,uuid,text)
  from public, anon, authenticated, service_role;

create function public.advance_auth_admin_operation(
  p_operation_id uuid,
  p_completion_token text,
  p_state text,
  p_external_target_id uuid default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.lock_active_superadmin_invariant();
  return private.advance_auth_admin_operation_invariant_inner(
    p_operation_id,
    p_completion_token,
    p_state,
    p_external_target_id,
    p_error
  );
end;
$$;

revoke execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  to service_role;
