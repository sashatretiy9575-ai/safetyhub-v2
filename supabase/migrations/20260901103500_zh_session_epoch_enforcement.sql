-- A passkey reset must invalidate more than the next refresh request.  JWTs
-- already issued before the reset remain cryptographically valid until their
-- normal expiry, so every application authorization entry point also binds a
-- synthetic ZH session to the current database auth epoch and exact GoTrue
-- session id.  Ordinary email-OTP users are unaffected.

create function private.zh_session_epoch_is_current(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_epoch bigint;
  v_claim_epoch bigint;
  v_session_id uuid;
begin
  select account.auth_epoch into v_epoch
  from private.zh_webauthn_accounts account
  where account.user_id = p_user_id;

  if not found then
    return true;
  end if;
  if v_claims ->> 'safetyhub_auth_kind' <> 'zh_passkey'
    or coalesce(v_claims ->> 'safetyhub_zh_epoch', '') !~ '^[1-9][0-9]{0,18}$'
    or coalesce(v_claims ->> 'session_id', '')
      !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  begin
    v_claim_epoch := (v_claims ->> 'safetyhub_zh_epoch')::bigint;
    v_session_id := (v_claims ->> 'session_id')::uuid;
  exception when others then
    return false;
  end;

  if v_claim_epoch is distinct from v_epoch then
    return false;
  end if;
  return exists (
    select 1
    from private.zh_authorized_sessions session_row
    where session_row.session_id = v_session_id
      and session_row.user_id = p_user_id
      and session_row.auth_epoch = v_epoch
  );
end;
$$;

revoke all on function private.zh_session_epoch_is_current(uuid)
  from public, anon, authenticated, service_role;

-- Capability checks are used directly by several RLS policies.  Enforce the
-- epoch when the inspected actor is the current request actor, while retaining
-- existing background/service validation of a stored operation owner.
create or replace function private.actor_has_capability(
  p_actor_id uuid,
  p_capability text
)
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
    join public.admin_capability_catalog catalog
      on catalog.capability = p_capability
    where role.user_id = p_actor_id
      and role.product_role = 'admin'
      and control.status = 'active'
      and not control.deletion_pending
      and (
        p_actor_id is distinct from (select auth.uid())
        or private.zh_session_epoch_is_current(p_actor_id)
      )
  );
$$;

create or replace function private.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  if not private.zh_session_epoch_is_current(v_user_id) then
    raise exception using errcode = 'insufficient_privilege', message = 'SESSION_REAUTHENTICATION_REQUIRED';
  end if;
  if not exists (
    select 1
    from public.account_controls control
    where control.user_id = v_user_id
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;
  return v_user_id;
end;
$$;

-- get_auth_context is the first application read after cookie authentication;
-- return no row for a reset/stale synthetic session so every server route
-- fails closed before it can expose profile or account state.
create or replace function public.get_auth_context()
returns table (
  user_id uuid,
  email text,
  profile_id uuid,
  profile_name text,
  profile_surname text,
  profile_job text,
  profile_organization text,
  profile_phone_country_iso2 text,
  profile_phone_e164 text,
  profile_preferred_locale public.app_locale,
  profile_avatar_updated_at timestamptz,
  profile_onboarding_completed_at timestamptz,
  profile_identity_state text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  role public.product_role,
  status public.account_status,
  deletion_pending boolean,
  approval_state public.account_approval_state,
  approval_requested_at timestamptz,
  approval_due_at timestamptz,
  approval_decided_at timestamptz,
  approval_rejection_reason text,
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
    case when private.is_zh_synthetic_user(auth_user.id)
      then null else auth_user.email::text end,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.phone_country_iso2,
    profile.phone_e164,
    profile.preferred_locale,
    profile.avatar_updated_at,
    profile.onboarding_completed_at,
    private.identity_state(profile.id),
    profile.created_at,
    profile.updated_at,
    user_role.product_role,
    control.status,
    control.deletion_pending,
    control.approval_state,
    control.approval_requested_at,
    control.approval_due_at,
    control.approval_decided_at,
    control.approval_rejection_reason,
    public.get_my_capabilities(),
    private.has_current_legal_acceptance(profile.id)
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  join public.user_roles user_role on user_role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = (select auth.uid())
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp())
    and private.zh_session_epoch_is_current(auth_user.id);
$$;

comment on function private.zh_session_epoch_is_current(uuid) is
  'Fail-closed request-time binding of a synthetic ZH JWT to its current auth epoch and exact authorized GoTrue session.';
