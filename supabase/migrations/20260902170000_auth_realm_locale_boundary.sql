-- Auth realm / locale boundary.
--
-- A locale is display/content selection, not a credential selector. RU, KK
-- and EN are one email-OTP realm; ZH is the separately server-bound
-- username/password realm. Keep the authoritative decision in private SQL so
-- a hand-written RPC request, stale browser bundle, or direct localized URL
-- cannot move an account across that boundary.

create function private.assert_locale_matches_auth_realm(
  p_user_id uuid,
  p_locale public.app_locale
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auth_kind text;
  v_is_zh_username_account boolean := false;
begin
  if p_user_id is null then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_USER_REQUIRED';
  end if;
  if p_locale is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'LOCALE_REQUIRED';
  end if;

  select auth_user.raw_app_meta_data ->> 'safetyhub_auth_kind'
  into v_auth_kind
  from auth.users auth_user
  where auth_user.id = p_user_id
    and auth_user.deleted_at is null;
  if not found then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_USER_REQUIRED';
  end if;

  select exists (
    select 1
    from private.zh_username_accounts username_account
    where username_account.user_id = p_user_id
  ) into v_is_zh_username_account;

  if v_is_zh_username_account then
    -- A mapping alone is not enough: its signed GoTrue app metadata must
    -- attest to the same credential method. This also fails closed during a
    -- partial/recovery migration.
    if v_auth_kind is distinct from 'zh_username_password' then
      raise exception using errcode = 'insufficient_privilege',
        message = 'AUTH_REALM_INVALID';
    end if;
    if p_locale <> 'zh'::public.app_locale then
      raise exception using errcode = 'insufficient_privilege',
        message = 'AUTH_REALM_LOCALE_MISMATCH';
    end if;
    return;
  end if;

  -- No non-ZH account may acquire the Chinese realm just by submitting a
  -- Chinese locale. A stale legacy/passkey marker is likewise unavailable
  -- until its explicit server-side recovery is complete.
  if v_auth_kind in ('zh_username_password', 'zh_passkey') then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_INVALID';
  end if;
  if p_locale = 'zh'::public.app_locale then
    raise exception using errcode = 'insufficient_privilege',
      message = 'AUTH_REALM_LOCALE_MISMATCH';
  end if;
end;
$$;

-- Before/after checks are deliberately aggregate-only. They make the one-way
-- correction observable in migration output without exporting a profile,
-- email, username, or other personal data.
do $$
declare
  v_zh_before bigint;
  v_normal_before bigint;
  v_zh_after bigint;
  v_normal_after bigint;
begin
  select count(*) into v_zh_before
  from public.profiles profile
  join private.zh_username_accounts username_account
    on username_account.user_id = profile.id
  where profile.preferred_locale <> 'zh'::public.app_locale;

  select count(*) into v_normal_before
  from public.profiles profile
  where profile.preferred_locale = 'zh'::public.app_locale
    and not exists (
      select 1
      from private.zh_username_accounts username_account
      where username_account.user_id = profile.id
    );

  raise notice 'auth realm locale normalization candidates: mapped_zh=%, normal_zh=%',
    v_zh_before, v_normal_before;

  update public.profiles profile
  set preferred_locale = 'zh'::public.app_locale
  where profile.preferred_locale <> 'zh'::public.app_locale
    and exists (
      select 1
      from private.zh_username_accounts username_account
      where username_account.user_id = profile.id
    );

  update public.profiles profile
  set preferred_locale = 'ru'::public.app_locale
  where profile.preferred_locale = 'zh'::public.app_locale
    and not exists (
      select 1
      from private.zh_username_accounts username_account
      where username_account.user_id = profile.id
    );

  select count(*) into v_zh_after
  from public.profiles profile
  join private.zh_username_accounts username_account
    on username_account.user_id = profile.id
  where profile.preferred_locale <> 'zh'::public.app_locale;

  select count(*) into v_normal_after
  from public.profiles profile
  where profile.preferred_locale = 'zh'::public.app_locale
    and not exists (
      select 1
      from private.zh_username_accounts username_account
      where username_account.user_id = profile.id
    );

  raise notice 'auth realm locale normalization remaining: mapped_zh=%, normal_zh=%',
    v_zh_after, v_normal_after;
  if v_zh_after <> 0 or v_normal_after <> 0 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'AUTH_REALM_LOCALE_NORMALIZATION_INCOMPLETE';
  end if;
end;
$$;

create or replace function public.set_preferred_locale(p_locale public.app_locale)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  update public.profiles
  set preferred_locale = p_locale
  where id = v_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'PROFILE_NOT_FOUND';
  end if;
  return jsonb_build_object('locale', p_locale);
end;
$$;

create or replace function public.get_profile_dashboard_locale(
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dashboard jsonb;
  v_attestations jsonb;
  v_expected integer;
  v_actual integer;
  v_user_id uuid := private.require_active_user();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);

  v_dashboard := public.get_profile_dashboard();
  v_expected := jsonb_array_length(
    coalesce(v_dashboard -> 'attestations', '[]'::jsonb)
  );

  select
    coalesce(jsonb_agg(
      attestation.item || jsonb_build_object(
        'courseTitle', localization.title
      )
      order by localization.title,
        (attestation.item ->> 'testVersion')::integer desc
    ), '[]'::jsonb),
    count(*)::integer
  into v_attestations, v_actual
  from jsonb_array_elements(
    coalesce(v_dashboard -> 'attestations', '[]'::jsonb)
  ) attestation(item)
  join public.tests test
    on test.id = (attestation.item ->> 'testId')::uuid
  join public.test_revisions revision
    on revision.id = test.current_revision_id
  join public.test_revision_localizations localization
    on localization.revision_id = revision.id
   and localization.locale = p_locale;

  if v_actual is distinct from v_expected then
    raise exception using errcode = 'no_data_found',
      message = 'COURSE_LOCALIZATION_NOT_FOUND';
  end if;

  return jsonb_set(v_dashboard, '{attestations}', v_attestations, false);
end;
$$;

create or replace function public.get_approved_course_presentation_locale(
  p_course_slug text,
  p_asset text,
  p_locale public.app_locale
)
returns table (
  presentation_id uuid,
  content_type text,
  byte_size bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_approved_learner();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  if p_course_slug is null
    or char_length(p_course_slug) not between 1 and 120
    or p_course_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or p_asset is null
    or p_asset not in ('presentation', 'thumbnail') then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
  return query
  select
    presentation.id,
    case when p_asset = 'presentation' then 'application/pdf' else 'image/webp' end,
    case when p_asset = 'presentation' then presentation.byte_size else null end
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.test_revision_presentations mapping
    on mapping.revision_id = revision.id and mapping.locale = p_locale
  join public.course_presentations presentation
    on presentation.id = mapping.presentation_id
  where test.slug = p_course_slug
    and test.status = 'published'
    and presentation.status = 'ready'
    and presentation.storage_bucket = 'course-presentations'
    and (p_asset = 'presentation' or presentation.thumbnail_path is not null)
  limit 1;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
  end if;
end;
$$;

-- Compatibility callers have no locale argument. Bind them to the actor's
-- stored locale before returning a legacy presentation row, so they cannot
-- become a bypass around the locale-aware endpoint during a rolling deploy.
create or replace function public.get_approved_course_presentation(
  p_course_slug text,
  p_asset text
)
returns table (
  presentation_id uuid,
  content_type text,
  byte_size bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_approved_learner();
  v_locale public.app_locale;
begin
  select profile.preferred_locale into v_locale
  from public.profiles profile
  where profile.id = v_user_id;
  perform private.assert_locale_matches_auth_realm(v_user_id, v_locale);
  return query
  select *
  from public.get_approved_course_presentation_locale(
    p_course_slug, p_asset, v_locale
  );
end;
$$;

create or replace function public.start_test_attempt_locale(
  p_test_slug text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_detail text;
  v_user_id uuid := private.require_approved_learner();
begin
  perform private.assert_locale_matches_auth_realm(v_user_id, p_locale);
  perform private.enforce_actor_quota('attempt.start');
  begin
    perform set_config('safetyhub.request_locale', p_locale::text, true);
    v_result := private.start_test_attempt_unmetered(p_test_slug);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return private.rpc_error_envelope(sqlstate, sqlerrm, v_detail);
  end;
end;
$$;

create or replace function public.get_test_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_approved_learner();
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = p_attempt_id and attempt.user_id = v_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  perform private.assert_locale_matches_auth_realm(v_user_id, v_attempt.locale);
  if v_attempt.status = 'started' and v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = statement_timestamp()
    where id = v_attempt.id and status = 'started' and expires_at <= statement_timestamp();
  end if;
  return private.attempt_payload(v_attempt.id);
end;
$$;

create or replace function public.complete_test_attempt(
  p_attempt_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_user_id uuid := private.require_approved_learner();
  v_locale public.app_locale;
begin
  -- Resolve only an actor-owned row before comparing its immutable attempt
  -- locale. A foreign/missing attempt preserves the established opaque error
  -- envelope from the inner completion function.
  select attempt.locale into v_locale
  from public.test_attempts attempt
  where attempt.id = p_attempt_id
    and attempt.user_id = v_user_id;
  if found then
    perform private.assert_locale_matches_auth_realm(v_user_id, v_locale);
  end if;

  perform private.enforce_actor_quota('attempt.complete');
  begin
    v_result := private.complete_test_attempt_unmetered(p_attempt_id, p_answers);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function private.assert_locale_matches_auth_realm(uuid,public.app_locale)
  from public, anon, authenticated, service_role;

revoke all on function public.set_preferred_locale(public.app_locale),
  public.get_profile_dashboard_locale(public.app_locale),
  public.get_approved_course_presentation_locale(text,text,public.app_locale),
  public.get_approved_course_presentation(text,text),
  public.start_test_attempt_locale(text,public.app_locale),
  public.get_test_attempt(uuid),
  public.complete_test_attempt(uuid,jsonb)
from public, anon, authenticated, service_role;

grant execute on function public.set_preferred_locale(public.app_locale),
  public.get_profile_dashboard_locale(public.app_locale),
  public.get_approved_course_presentation_locale(text,text,public.app_locale),
  public.get_approved_course_presentation(text,text),
  public.start_test_attempt_locale(text,public.app_locale),
  public.get_test_attempt(uuid),
  public.complete_test_attempt(uuid,jsonb)
to authenticated;

comment on function private.assert_locale_matches_auth_realm(uuid,public.app_locale) is
  'Fail-closed realm assertion: RU/KK/EN require an ordinary email-OTP account; ZH requires both the private username mapping and signed username/password app metadata.';
comment on function public.set_preferred_locale(public.app_locale) is
  'Updates an active actor preference only within its server-authorized auth realm.';
comment on function public.get_profile_dashboard_locale(public.app_locale) is
  'Returns an active actor dashboard only in the auth realm matching its requested locale.';
comment on function public.get_approved_course_presentation_locale(text,text,public.app_locale) is
  'Returns an approved learner presentation only in the auth realm matching its requested locale.';
comment on function public.start_test_attempt_locale(text,public.app_locale) is
  'Starts an approved learner attempt only in the auth realm matching its immutable locale.';
comment on function public.get_test_attempt(uuid) is
  'Returns an approved learner attempt only when its stored locale matches the current auth realm.';
comment on function public.complete_test_attempt(uuid,jsonb) is
  'Completes an approved learner attempt only when its stored locale matches the current auth realm.';
