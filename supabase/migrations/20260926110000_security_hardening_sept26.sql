-- Security hardening from the 26 September 2026 audit.
--
--   1. Organization search. `search_profile_organizations` answered any active
--      account, an unapproved sign-up included, with up to twenty names for a
--      two-letter substring and no budget: the whole directory (the training
--      centre's client list) could be read out a query at a time, although
--      the table's own policy keeps it to `identity.read`. It now needs three
--      normalized characters, returns at most eight names and spends a
--      per-account budget (`profile.organization.search`, 60 per 300 s). The
--      match stays a substring: «Арман» has to find «ТОО Арман Строй».
--   2. `admin.pii.read`, 120 per 600 s: the per-operator budget the employee
--      card's contact and certificate-history reads spend in the application
--      (server/security/rate-limit.ts -> consume_business_quota_for_actor).
--   3. Sign-out revocation. Signing out deletes the GoTrue session, but the
--      access token already issued stayed valid until it expired (up to an
--      hour): `get_auth_context`, `require_active_user` and
--      `actor_has_capability` only looked at `auth.uid()`. A request token that
--      names a session must now name one that still exists.
--
-- `private.quota_policy` is replaced wholesale, so the whole catalog from
-- 20260909100000_missing_quota_tariffs.sql is restated with the two new
-- actions added; listing only the new ones would drop every existing tariff.

create or replace function private.quota_policy(p_action text)
returns table (quota integer, window_seconds integer)
language sql
immutable
set search_path = ''
as $$
  select
    case p_action
      when 'certificate.pdf' then 20
      when 'certificate.export' then 5
      when 'certificate.export.download' then 30
      when 'presentation.download' then 12
      when 'presentation.probe' then 60
      when 'attempt.start' then 30
      when 'attempt.complete' then 30
      when 'auth.register' then 10
      when 'auth.otp.start' then 20
      when 'auth.otp.start.email' then 5
      when 'auth.otp.verify' then 30
      when 'auth.otp.verify.email' then 6
      when 'auth.zh.registration.options' then 10
      when 'auth.zh.registration.verify' then 15
      when 'auth.zh.authentication.options' then 60
      when 'auth.zh.authentication.verify' then 30
      when 'auth.zh.authentication.credential' then 10
      when 'auth.zh.recovery.options' then 10
      when 'auth.zh.recovery.verify' then 10
      when 'auth.zh.recovery.locator' then 5
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'profile.organization.search' then 60
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'admin.read.query' then 30
      when 'admin.pii.read' then 120
      when 'admin.zh_credential.reset' then 10
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.purge' then 50
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in ('auth.otp.start', 'auth.otp.start.email') then 900
      when p_action in ('auth.otp.verify', 'auth.otp.verify.email') then 900
      when p_action in (
        'auth.zh.registration.options', 'auth.zh.recovery.options',
        'auth.zh.recovery.verify', 'auth.zh.recovery.locator'
      ) then 3600
      when p_action in (
        'auth.zh.registration.verify', 'auth.zh.authentication.options',
        'auth.zh.authentication.verify', 'auth.zh.authentication.credential'
      ) then 900
      when p_action = 'admin.pii.read' then 600
      when p_action in (
        'presentation.download', 'presentation.probe', 'profile.update',
        'profile.organization.search',
        'legal.accept', 'content.article.mutate', 'site.settings.update',
        'admin.access.mutate', 'admin.test.mutate', 'admin.zh_credential.reset',
        'admin.invite', 'admin.suspend', 'admin.delete', 'admin.purge',
        'admin.reconcile', 'certificate.export', 'certificate.export.download'
      ) then 300
      else 60
    end;
$$;

revoke all on function private.quota_policy(text)
  from public, anon, authenticated, service_role;

-- VOLATILE, no longer STABLE: the search now writes its quota row, and
-- PostgREST runs a STABLE function in a read-only transaction, where that
-- insert would fail.
create or replace function public.search_profile_organizations(p_query text, p_limit integer default 8)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_query text := private.normalize_organization_key(p_query);
  v_pattern text := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(v_query, '\', '\\'),
      '%', '\%'
    ),
    '_', '\_'
  );
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 8);
begin
  -- One or two letters match most of the directory. The form only asks from
  -- three, so a shorter query is answered empty and spends no budget.
  if char_length(pg_catalog.btrim(v_query)) < 3 then
    return '{}'::text[];
  end if;
  perform private.enforce_actor_quota('profile.organization.search');

  return coalesce((
    select array_agg(candidate.canonical_name order by candidate.rank, candidate.canonical_name)
    from (
      select distinct organization.canonical_name,
        case
          when organization.normalized_key = v_query then 0
          when organization.normalized_key like v_pattern || '%' escape '\' then 1
          else 2
        end as rank
      from public.organizations organization
      left join public.organization_aliases alias on alias.organization_id = organization.id
      where organization.active
        and (
          organization.normalized_key like '%' || v_pattern || '%' escape '\'
          or alias.normalized_key like '%' || v_pattern || '%' escape '\'
        )
      order by rank, organization.canonical_name
      limit v_limit
    ) candidate
  ), '{}'::text[]);
end;
$$;

revoke all on function public.search_profile_organizations(text, integer)
  from public, anon, service_role;
grant execute on function public.search_profile_organizations(text, integer) to authenticated;

-- The check below reads auth.sessions as the function owner. A project where
-- that grant is missing would refuse every signed-in request, so the migration
-- stops here instead of shipping that outage.
do $$
begin
  if not has_table_privilege(current_user, 'auth.sessions', 'SELECT') then
    raise exception 'auth.sessions is not readable by %; the sign-out check cannot be installed', current_user;
  end if;
end;
$$;

-- Unchanged for ZH accounts and retired passkey accounts. For everyone else,
-- when the request's own actor is inspected and its token names a GoTrue
-- session, that session must still exist and not be past `not_after`.
--
--   * Service-role and scheduled calls carry no `sub`, so `auth.uid()` is null
--     and the check is skipped; `actor_has_capability` also skips this function
--     whenever the actor it inspects is not the request's own actor.
--   * Every access token GoTrue issues carries `session_id`. A token without it
--     cannot be obtained without the signing key, so its absence is not treated
--     as a sign-out; the SQL regression suites, which set request claims
--     directly, keep their existing fixtures.
--   * A `session_id` that is present but malformed is refused.
create or replace function private.zh_session_epoch_is_current(p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_session_id uuid;
begin
  if exists (
    select 1
    from private.zh_username_accounts username_account
    where username_account.user_id = p_user_id
  ) then
    if not private.runtime_feature_enabled('zh_username_password') then
      return false;
    end if;
    if v_claims ->> 'safetyhub_auth_kind' <> 'zh_username_password'
      or coalesce(v_claims ->> 'session_id', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return false;
    end if;
    begin
      v_session_id := (v_claims ->> 'session_id')::uuid;
    exception when others then
      return false;
    end;
    return exists (
      select 1
      from private.zh_username_authorized_sessions session_row
      join private.zh_username_accounts username_account
        on username_account.user_id = session_row.user_id
      where session_row.session_id = v_session_id
        and session_row.user_id = p_user_id
        and not username_account.password_change_pending
    );
  end if;

  if exists (
    select 1
    from private.zh_webauthn_accounts legacy_account
    where legacy_account.user_id = p_user_id
  ) then
    return false;
  end if;

  if p_user_id = (select auth.uid()) and v_claims ? 'session_id' then
    begin
      v_session_id := (v_claims ->> 'session_id')::uuid;
    exception when others then
      return false;
    end;
    return exists (
      select 1
      from auth.sessions session_row
      where session_row.id = v_session_id
        and session_row.user_id = p_user_id
        and (
          session_row.not_after is null
          or session_row.not_after > statement_timestamp()
        )
    );
  end if;
  return true;
end;
$$;

revoke all on function private.zh_session_epoch_is_current(uuid)
  from public, anon, authenticated, service_role;

comment on function private.zh_session_epoch_is_current(uuid) is
  'Fail-closed request-time session binding: a synthetic ZH JWT to its authorized username session, any other JWT that names a GoTrue session to a session that still exists (sign-out revokes the access token at once).';
