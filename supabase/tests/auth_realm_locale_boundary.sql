begin;

do $contract$
declare
  v_normal_user_id uuid := '7c000000-0000-4000-8000-000000000001';
  v_zh_user_id uuid := '7c000000-0000-4000-8000-000000000002';
  v_attempt_id uuid := '7c000000-0000-4000-8000-000000000003';
  v_revision_id uuid;
  v_test_id uuid;
  v_variant_id uuid;
  v_duration_minutes integer;
  v_pass_score integer;
  v_attempts_per_day integer;
  v_reset_timezone text;
  v_definition text;
  v_blocked boolean;
begin
  if to_regprocedure(
    'private.assert_locale_matches_auth_realm(uuid,public.app_locale)'
  ) is null then
    raise exception 'auth realm locale assertion is missing';
  end if;
  if has_function_privilege(
    'anon',
    'private.assert_locale_matches_auth_realm(uuid,public.app_locale)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'private.assert_locale_matches_auth_realm(uuid,public.app_locale)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'private.assert_locale_matches_auth_realm(uuid,public.app_locale)',
    'execute'
  ) then
    raise exception 'private auth realm assertion leaked to a callable role';
  end if;

  foreach v_definition in array array[
    lower(pg_get_functiondef('public.set_preferred_locale(public.app_locale)'::regprocedure)),
    lower(pg_get_functiondef('public.get_profile_dashboard_locale(public.app_locale)'::regprocedure)),
    lower(pg_get_functiondef(
      'public.get_approved_course_presentation_locale(text,text,public.app_locale)'::regprocedure
    )),
    lower(pg_get_functiondef('public.start_test_attempt_locale(text,public.app_locale)'::regprocedure)),
    lower(pg_get_functiondef('public.get_test_attempt(uuid)'::regprocedure)),
    lower(pg_get_functiondef('public.complete_test_attempt(uuid,jsonb)'::regprocedure))
  ] loop
    if position('private.assert_locale_matches_auth_realm' in v_definition) = 0 then
      raise exception 'locale-aware browser RPC bypasses the auth realm assertion';
    end if;
  end loop;

  -- Auth-user insertion invokes the normal profile/role/control bootstrap.
  -- The private mapping is the extra source of truth for the Chinese realm.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000',
      v_normal_user_id,
      'authenticated', 'authenticated', 'realm-normal@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      v_zh_user_id,
      'authenticated', 'authenticated', 'cccccccccccccccccccccccccccccccc@auth.invalid', '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(), statement_timestamp()
    );
  insert into private.zh_username_accounts (user_id, username, synthetic_email)
  values (
    v_zh_user_id,
    'realmzh001',
    'cccccccccccccccccccccccccccccccc@auth.invalid'
  );
  update public.profiles
  set preferred_locale = 'zh'::public.app_locale
  where id = v_zh_user_id;

  -- The primitive itself does not rely on a profile preference and rejects
  -- both directions of a realm switch.
  perform private.assert_locale_matches_auth_realm(
    v_normal_user_id, 'kk'::public.app_locale
  );
  perform private.assert_locale_matches_auth_realm(
    v_zh_user_id, 'zh'::public.app_locale
  );

  -- A retired passkey marker is neither realm. It must fail closed instead
  -- of being treated as an ordinary email session while the account awaits
  -- explicit username/password recovery.
  update auth.users
  set raw_app_meta_data = jsonb_build_object('safetyhub_auth_kind', 'zh_passkey')
  where id = v_zh_user_id;
  v_blocked := false;
  begin
    perform private.assert_locale_matches_auth_realm(
      v_zh_user_id, 'zh'::public.app_locale
    );
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_INVALID' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'retired ZH passkey marker was assigned a realm';
  end if;
  update auth.users
  set raw_app_meta_data = jsonb_build_object('safetyhub_auth_kind', 'zh_username_password')
  where id = v_zh_user_id;

  v_blocked := false;
  begin
    perform private.assert_locale_matches_auth_realm(
      v_normal_user_id, 'zh'::public.app_locale
    );
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account accepted the ZH realm';
  end if;

  v_blocked := false;
  begin
    perform private.assert_locale_matches_auth_realm(
      v_zh_user_id, 'en'::public.app_locale
    );
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'mapped ZH account accepted an email-OTP locale';
  end if;

  -- Exercise the public write and read boundaries as an ordinary active
  -- account. No client-supplied locale can cross into ZH.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_normal_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_normal_user_id)::text,
    true
  );
  perform public.set_preferred_locale('en'::public.app_locale);
  if (select preferred_locale from public.profiles where id = v_normal_user_id)
    is distinct from 'en'::public.app_locale then
    raise exception 'same-realm preference update did not persist once';
  end if;

  v_blocked := false;
  begin
    perform public.set_preferred_locale('zh'::public.app_locale);
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked
    or (select preferred_locale from public.profiles where id = v_normal_user_id)
      is distinct from 'en'::public.app_locale then
    raise exception 'cross-realm preference write changed the normal account';
  end if;

  v_blocked := false;
  begin
    perform public.get_profile_dashboard_locale('zh'::public.app_locale);
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account opened a ZH dashboard projection';
  end if;

  update public.account_controls
  set approval_state = 'approved',
      approval_requested_at = null,
      approval_due_at = null,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_normal_user_id;
  insert into public.legal_acceptances (
    user_id, document_type, version, source
  )
  select v_normal_user_id, document.document_type, document.version, 'profile'
  from public.legal_document_versions document
  where document.is_current
    and document.document_type in ('privacy', 'terms')
  on conflict do nothing;

  v_blocked := false;
  begin
    perform public.start_test_attempt_locale(
      'realm-boundary-missing-course', 'zh'::public.app_locale
    );
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account started a ZH attempt route';
  end if;

  v_blocked := false;
  begin
    perform public.get_approved_course_presentation_locale(
      'realm-boundary-missing-course', 'presentation', 'zh'::public.app_locale
    );
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account opened a ZH presentation route';
  end if;

  select
    revision.id,
    revision.test_id,
    variant.id,
    revision.duration_minutes,
    revision.pass_score,
    revision.attempts_per_calendar_day,
    revision.attempt_reset_timezone
  into
    v_revision_id,
    v_test_id,
    v_variant_id,
    v_duration_minutes,
    v_pass_score,
    v_attempts_per_day,
    v_reset_timezone
  from public.test_revisions revision
  join public.test_revision_variants variant on variant.revision_id = revision.id
  order by revision.published_at, revision.id, variant.id
  limit 1;
  if v_revision_id is null then
    raise exception 'realm boundary test requires a seeded course variant';
  end if;

  -- A historical malformed/cross-realm attempt cannot be resumed or submitted
  -- just because the browser currently has a normal auth cookie.
  -- The production insert trigger correctly pins direct writes to RU, so this
  -- fixture disables it only inside the rolled-back test transaction to model
  -- an already-corrupted legacy row.
  alter table public.test_attempts disable trigger test_attempts_pin_locale;
  insert into public.test_attempts (
    id, user_id, revision_id, test_id, variant_id, locale,
    duration_minutes, pass_score, attempts_per_day, reset_timezone,
    started_at, expires_at
  ) values (
    v_attempt_id, v_normal_user_id, v_revision_id, v_test_id, v_variant_id,
    'zh'::public.app_locale, v_duration_minutes, v_pass_score,
    v_attempts_per_day, v_reset_timezone,
    statement_timestamp(), statement_timestamp() + interval '15 minutes'
  );
  alter table public.test_attempts enable trigger test_attempts_pin_locale;

  v_blocked := false;
  begin
    perform public.get_test_attempt(v_attempt_id);
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account resumed a stored ZH attempt';
  end if;

  v_blocked := false;
  begin
    perform public.complete_test_attempt(v_attempt_id, '[]'::jsonb);
  exception when insufficient_privilege then
    if sqlerrm = 'AUTH_REALM_LOCALE_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'normal account submitted a stored ZH attempt';
  end if;
end;
$contract$;

rollback;
