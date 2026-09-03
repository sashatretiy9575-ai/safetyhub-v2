begin;

-- The Chinese admission bypass is gone: no locale and no credential type may
-- reach a test without the same profile and photo as everyone else, and the
-- one-off backfill left no account admitted under the old rule.
do $contract$
declare
  v_user_id uuid := '7c000000-0000-4000-8000-000000000001';
  v_session_id uuid := '7c000000-0000-4000-8000-000000000002';
  v_test_slug text;
  v_blocked boolean := false;
  v_message text;
begin
  if to_regprocedure('private.is_approved_zh_username_learner(uuid)') is not null then
    raise exception 'the ZH admission bypass function still exists';
  end if;

  -- The migration must have left no Chinese account admitted without a profile.
  if exists (
    select 1
    from private.zh_username_accounts account
    join public.profiles profile on profile.id = account.user_id
    join public.account_controls control on control.user_id = account.user_id
    where profile.onboarding_completed_at is null
      and control.approval_state in ('pending', 'approved')
  ) then
    raise exception 'a ZH account is still pending or approved without a profile';
  end if;

  select test.slug into v_test_slug
  from public.tests test
  where test.status = 'published' and test.current_revision_id is not null
  order by test.slug
  limit 1;
  if v_test_slug is null then
    raise exception 'no published course fixture is available';
  end if;

  -- Even if an account were force-approved with an empty profile, the attempt
  -- RPC must still refuse it. This is the guard the bypass used to waive.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    'dddddddddddddddddddddddddddddddd@auth.invalid',
    '',
    statement_timestamp(),
    jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
    jsonb_build_object('preferred_locale', 'zh'),
    statement_timestamp(),
    statement_timestamp()
  );
  update public.profiles set preferred_locale = 'zh' where id = v_user_id;
  -- The auto-approved shape (no review window), which the constraint allows.
  update public.account_controls
  set approval_state = 'approved'
  where user_id = v_user_id;
  insert into public.legal_acceptances (user_id, document_type, version, accepted_at, source)
  select v_user_id, version.document_type, version.version, statement_timestamp(), 'registration'
  from public.legal_document_versions version
  where version.is_current;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user_id,
      'safetyhub_auth_kind', 'zh_username_password',
      'session_id', v_session_id
    )::text,
    true
  );
  begin
    perform private.start_test_attempt_unmetered(v_test_slug);
  exception when object_not_in_prerequisite_state then
    v_message := sqlerrm;
    v_blocked := true;
  end;
  if not v_blocked or v_message <> 'PROFILE_ONBOARDING_REQUIRED' then
    raise exception 'approved ZH account without a profile started a test: %', v_message;
  end if;

  -- With a profile but no photo the ordinary avatar gate must still apply.
  update public.profiles
  set name = '伟',
      surname = '张',
      job = '安全工程师',
      organization = 'SafetyHub ZH admission',
      onboarding_completed_at = statement_timestamp()
  where id = v_user_id;
  v_blocked := false;
  begin
    perform private.start_test_attempt_unmetered(v_test_slug);
  exception when object_not_in_prerequisite_state then
    v_message := sqlerrm;
    v_blocked := true;
  end;
  if not v_blocked or v_message <> 'AVATAR_REQUIRED' then
    raise exception 'ZH account without a photo started a test: %', v_message;
  end if;
end;
$contract$;

rollback;
