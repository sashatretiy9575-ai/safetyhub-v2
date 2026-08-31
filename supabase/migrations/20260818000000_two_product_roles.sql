-- Product access is intentionally two-role: participant and admin.
--
-- The legacy app_role column stays in place for rolling-deploy compatibility
-- with already-running database functions. It is no longer returned to the
-- application and no longer participates in authorization. This lets a hosted
-- project migrate without an unsafe enum/type rewrite while making the product
-- model, authorization model and all new writes strictly two-role.

create type public.product_role as enum ('participant', 'admin');

alter table public.user_roles
  add column product_role public.product_role not null default 'participant';

update public.user_roles
set product_role = case
  when role in ('admin', 'superadmin') then 'admin'::public.product_role
  else 'participant'::public.product_role
end;

create function private.sync_product_role_from_legacy_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.product_role := case
    when new.role in ('admin', 'superadmin') then 'admin'::public.product_role
    else 'participant'::public.product_role
  end;
  return new;
end;
$$;

create trigger user_roles_sync_product_role
before insert or update of role on public.user_roles
for each row execute function private.sync_product_role_from_legacy_role();

revoke execute on function private.sync_product_role_from_legacy_role()
  from public, anon, authenticated, service_role;

-- Every admin receives the complete operator surface. The former assignment
-- matrix is deliberately ignored, but its rows and old audit entries are kept
-- as historical evidence during the rolling migration.
create or replace function private.actor_has_capability(p_actor_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles role
    join public.account_controls control on control.user_id = role.user_id
    join public.admin_capability_catalog catalog on catalog.capability = p_capability
    where role.user_id = p_actor_id
      and role.product_role = 'admin'
      and control.status = 'active'
      and not control.deletion_pending
  );
$$;

drop function public.get_auth_context();
create function public.get_auth_context()
returns table (
  user_id uuid,
  email text,
  profile_id uuid,
  profile_name text,
  profile_surname text,
  profile_job text,
  profile_organization text,
  profile_avatar_updated_at timestamptz,
  profile_onboarding_completed_at timestamptz,
  profile_identity_state text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  role public.product_role,
  status public.account_status,
  deletion_pending boolean,
  capabilities text[],
  has_current_legal_acceptance boolean
)
language sql
stable
security definer
set search_path = ''
rows 1
as $$
  select
    auth_user.id,
    auth_user.email::text,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.avatar_updated_at,
    profile.onboarding_completed_at,
    private.identity_state(profile.id),
    profile.created_at,
    profile.updated_at,
    user_role.product_role,
    control.status,
    control.deletion_pending,
    public.get_my_capabilities(),
    private.has_current_legal_acceptance(profile.id)
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  join public.user_roles user_role on user_role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = (select auth.uid())
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp());
$$;

revoke execute on function public.get_auth_context() from public, anon, service_role;
grant execute on function public.get_auth_context() to authenticated;

-- Deployment-only break glass. It creates no extra product role and is never
-- callable with a browser session.
create function public.restore_admin_access(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:admin-break-glass', 0));
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles
  set role = 'admin', product_role = 'admin', created_by = null
  where user_id = p_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, after_data
  ) values (
    null, p_user_id, 'admin.break_glass_restored', 'user', p_user_id::text,
    jsonb_build_object('role', 'admin', 'source', 'service_only')
  );
  return p_user_id;
end;
$$;

revoke execute on function public.restore_admin_access(uuid)
  from public, anon, authenticated;
grant execute on function public.restore_admin_access(uuid) to service_role;

-- Disable the obsolete browser-facing role/capability mutation surface. Old
-- functions remain only so in-flight deployments do not fail during rollout.
revoke execute on function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.bootstrap_superadmin(uuid)
  from public, anon, authenticated, service_role;

comment on column public.user_roles.product_role is
  'Authoritative product role. Only participant and admin are exposed or authorized.';
comment on function public.restore_admin_access(uuid) is
  'Deployment-only break glass that restores the existing admin product role.';
