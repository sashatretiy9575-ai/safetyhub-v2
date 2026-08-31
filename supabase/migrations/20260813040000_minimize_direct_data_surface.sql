-- Minimize direct PostgREST table access and rebind the onboarding dependency
-- to the metered profile mutation API.

create or replace function public.complete_profile_onboarding(
  p_name text,
  p_surname text,
  p_job text,
  p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_result jsonb;
begin
  if not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.avatar_updated_at is not null
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AVATAR_REQUIRED';
  end if;
  -- The public wrapper owns the actor quota. Calling the moved private
  -- implementation here would allow direct onboarding RPC calls to bypass it.
  v_result := public.update_profile(p_name, p_surname, p_job, p_organization);
  update public.profiles
  set onboarding_completed_at = coalesce(onboarding_completed_at, statement_timestamp())
  where id = v_user_id;
  return v_result || jsonb_build_object('completed', true);
end;
$$;

revoke execute on function public.complete_profile_onboarding(text,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_profile_onboarding(text,text,text,text)
  to authenticated;

-- All private/account/admin data is delivered by reviewed SECURITY DEFINER
-- read models. No browser component needs table-level SELECT, so remove a
-- second, wider path that could bypass response minimization.
revoke select on public.profiles,
  public.user_roles,
  public.account_controls,
  public.admin_capability_catalog,
  public.user_capabilities,
  public.verified_identities,
  public.test_attempts,
  public.attestations,
  public.certificates,
  public.legal_acceptances,
  public.admin_audit_log
from authenticated;

-- Future tables/functions created by the migration owner start closed. Each
-- browser RPC or public content column set must be granted explicitly in its
-- own migration. Service-role access continues through explicit grants and
-- the existing BYPASSRLS platform role.
alter default privileges in schema public
  revoke all on tables from public, anon, authenticated;
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges in schema public
  revoke usage, select on sequences from public, anon, authenticated;

alter default privileges in schema private
  revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema private
  revoke execute on functions from public, anon, authenticated, service_role;
alter default privileges in schema private
  revoke usage, select on sequences from public, anon, authenticated, service_role;
