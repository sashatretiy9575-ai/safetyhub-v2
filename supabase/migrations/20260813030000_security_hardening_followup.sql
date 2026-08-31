-- Follow-up for invariants that require the already-applied hardening objects.

-- Export resolution itself is a database-heavy authenticated RPC and appends
-- an audit row. Meter it at the database boundary so direct PostgREST calls
-- cannot bypass the application route quota.
alter function public.resolve_certificate_export(uuid[])
  rename to resolve_certificate_export_unmetered;
alter function public.resolve_certificate_export_unmetered(uuid[])
  set schema private;
revoke all on function private.resolve_certificate_export_unmetered(uuid[])
  from public, anon, authenticated, service_role;

create function public.resolve_certificate_export(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('certificate.export');
  return private.resolve_certificate_export_unmetered(p_attestation_ids);
end;
$$;

revoke execute on function public.resolve_certificate_export(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.resolve_certificate_export(uuid[]) to authenticated;

-- Direct service-role provisioning and bootstrapping share the same invariant
-- lock as interactive role management. Provisioning an admin never mutates a
-- superadmin account.
create or replace function public.bootstrap_superadmin(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:superadmin-role', 0));
  if exists (select 1 from public.user_roles where role = 'superadmin') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'SUPERADMIN_ALREADY_EXISTS';
  end if;
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles
  set role = 'superadmin', created_by = null
  where user_id = p_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, after_data
  ) values (
    null, p_user_id, 'superadmin.bootstrapped', 'user', p_user_id::text,
    jsonb_build_object('source', 'service_only')
  );
  return p_user_id;
end;
$$;

create or replace function public.provision_admin_by_email(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_current_role public.app_role;
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:superadmin-role', 0));
  select auth_user.id, user_role.role
  into v_user_id, v_current_role
  from auth.users auth_user
  join public.user_roles user_role on user_role.user_id = auth_user.id
  where lower(auth_user.email::text) = lower(btrim(p_email))
    and auth_user.deleted_at is null
  order by auth_user.created_at
  limit 1
  for update of auth_user, user_role;
  if v_user_id is null then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if v_current_role = 'superadmin' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'SUPERADMIN_DEMOTION_FORBIDDEN';
  end if;
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles
  set role = 'admin', created_by = null
  where user_id = v_user_id;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, after_data
  ) values (
    null, v_user_id, 'admin.provisioned_by_email', 'user', v_user_id::text,
    jsonb_build_object('source', 'service_only')
  );
  return v_user_id;
end;
$$;

-- Account purge must preserve at least one superadmin. The shared advisory
-- lock serializes it with every supported superadmin role change.
create or replace function public.begin_user_account_purge(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending boolean;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'USER_ID_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:superadmin-role', 0));
  if exists (
    select 1 from public.user_roles
    where user_id = p_target_id and role = 'superadmin'
  ) and (select count(*) from public.user_roles where role = 'superadmin') <= 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LAST_SUPERADMIN_PROTECTED';
  end if;
  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id
  returning deletion_pending into v_pending;
  if not found then
    return jsonb_build_object('userId', p_target_id, 'exists', false, 'pending', true);
  end if;
  return jsonb_build_object('userId', p_target_id, 'exists', true, 'pending', v_pending);
end;
$$;

-- An account can be both issuer and revoker of one certificate. Clear both
-- references in one guarded UPDATE so the immutable snapshot trigger sees the
-- complete privacy-preserving transition atomically.
create or replace function public.purge_user_account(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'USER_ID_REQUIRED';
  end if;
  if not exists (select 1 from auth.users where id = p_target_id) then
    return jsonb_build_object('deleted', false, 'userId', p_target_id);
  end if;
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:superadmin-role', 0));
  if not exists (
    select 1 from public.account_controls
    where user_id = p_target_id and deletion_pending
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_PURGE_NOT_STARTED';
  end if;
  if exists (
    select 1 from public.user_roles
    where user_id = p_target_id and role = 'superadmin'
  ) and (select count(*) from public.user_roles where role = 'superadmin') <= 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LAST_SUPERADMIN_PROTECTED';
  end if;
  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  update public.test_revisions
  set published_by = null
  where published_by = p_target_id;
  update public.certificates
  set issued_by = case when issued_by = p_target_id then null else issued_by end,
      revoked_by = case when revoked_by = p_target_id then null else revoked_by end
  where issued_by = p_target_id or revoked_by = p_target_id;
  delete from public.admin_audit_log
  where actor_user_id = p_target_id or target_user_id = p_target_id;
  delete from private.auth_admin_outbox
  where actor_user_id = p_target_id or target_id = p_target_id;
  delete from auth.users where id = p_target_id;
  v_deleted := found;
  return jsonb_build_object('deleted', v_deleted, 'userId', p_target_id);
end;
$$;

-- CREATE OR REPLACE keeps grants, but state the service-only contract
-- explicitly to prevent future migration defaults from widening it.
revoke execute on function public.bootstrap_superadmin(uuid)
  from public, anon, authenticated;
grant execute on function public.bootstrap_superadmin(uuid) to service_role;
revoke execute on function public.provision_admin_by_email(text)
  from public, anon, authenticated;
grant execute on function public.provision_admin_by_email(text) to service_role;
revoke execute on function public.begin_user_account_purge(uuid)
  from public, anon, authenticated;
grant execute on function public.begin_user_account_purge(uuid) to service_role;
revoke execute on function public.purge_user_account(uuid)
  from public, anon, authenticated;
grant execute on function public.purge_user_account(uuid) to service_role;
