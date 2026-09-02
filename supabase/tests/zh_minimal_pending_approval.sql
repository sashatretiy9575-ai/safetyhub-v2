begin;

-- A fresh ZH username/password identity must be reviewable without being
-- forced through the normal profile/contact/telephone/avatar admission path.
-- The test uses only the local disposable database and rolls everything back.
do $contract$
declare
  v_user_id uuid := '7b000000-0000-4000-8000-000000000001';
  v_user_session_id uuid := '7b000000-0000-4000-8000-000000000007';
  v_admin_id uuid := '7b000000-0000-4000-8000-000000000002';
  v_rejected_user_id uuid := '7b000000-0000-4000-8000-000000000004';
  v_rejected_session_id uuid := '7b000000-0000-4000-8000-000000000008';
  v_ordinary_user_id uuid := '7b000000-0000-4000-8000-000000000005';
  v_result jsonb;
  v_context jsonb;
  v_queue_item jsonb;
  v_event_payload jsonb;
  v_attempt_id uuid;
  v_attestation_id uuid;
  v_variant_id uuid;
  v_revision_id uuid;
  v_test_slug text;
  v_expected_error text;
  v_ordinary_locale public.app_locale;
  v_answers jsonb;
  v_pending_start_blocked boolean := false;
  v_rejected_start_blocked boolean := false;
  v_certificate_blocked boolean := false;
  v_control public.account_controls%rowtype;
  v_privacy public.legal_document_versions%rowtype;
  v_terms public.legal_document_versions%rowtype;
begin
  if to_regprocedure(
    'public.complete_zh_username_registration(uuid,text,text,text,text,text,text)'
  ) is null
    or to_regprocedure(
      'private.add_zh_username_to_pending_approval_items(jsonb)'
    ) is null then
    raise exception 'minimal ZH pending-approval functions are missing';
  end if;
  if has_function_privilege(
    'anon',
    'public.complete_zh_username_registration(uuid,text,text,text,text,text,text)',
    'execute'
  ) or has_function_privilege(
    'authenticated',
    'public.complete_zh_username_registration(uuid,text,text,text,text,text,text)',
    'execute'
  ) or has_function_privilege(
    'service_role',
    'private.add_zh_username_to_pending_approval_items(jsonb)',
    'execute'
  ) then
    raise exception 'minimal ZH registration or private queue grants are unsafe';
  end if;

  update private.runtime_feature_flags
  set enabled = true
  where feature_name in ('zh_username_password', 'notification_events');
  update private.runtime_feature_flags
  set enabled = false
  where feature_name = 'telegram_application_details';

  select * into v_privacy
  from public.legal_document_versions document
  where document.document_type = 'privacy'
    and document.is_current;
  select * into v_terms
  from public.legal_document_versions document
  where document.document_type = 'terms'
    and document.is_current;
  if v_privacy.version is null or v_terms.version is null then
    raise exception 'current legal document versions are required';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000',
      v_user_id,
      'authenticated',
      'authenticated',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
      '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(),
      statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      v_admin_id,
      'authenticated',
      'authenticated',
      'minimal-zh-approval-admin@example.com',
      '',
      statement_timestamp(),
      '{}'::jsonb,
      '{}'::jsonb,
      statement_timestamp(),
      statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      v_rejected_user_id,
      'authenticated',
      'authenticated',
      'cccccccccccccccccccccccccccccccc@auth.invalid',
      '',
      statement_timestamp(),
      jsonb_build_object('safetyhub_auth_kind', 'zh_username_password'),
      jsonb_build_object('preferred_locale', 'zh'),
      statement_timestamp(),
      statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000',
      v_ordinary_user_id,
      'authenticated',
      'authenticated',
      'minimal-zh-ordinary-profile@example.com',
      '',
      statement_timestamp(),
      '{}'::jsonb,
      jsonb_build_object('preferred_locale', 'ru'),
      statement_timestamp(),
      statement_timestamp()
    );
  update public.user_roles
  set role = 'superadmin'
  where user_id = v_admin_id;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );
  v_result := public.complete_zh_username_registration(
    v_user_id,
    'zhminimal001',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid',
    v_privacy.version,
    v_privacy.body_revision,
    v_terms.version,
    v_terms.body_revision
  );
  if v_result ->> 'userId' <> v_user_id::text
    or v_result ->> 'approvalState' <> 'pending'
    or (v_result ->> 'approvalRequestedAt') is null
    or (v_result ->> 'approvalDueAt') is null then
    raise exception 'minimal ZH registration did not return a pending review: %', v_result;
  end if;

  select * into v_control
  from public.account_controls control
  where control.user_id = v_user_id;
  if v_control.approval_state <> 'pending'
    or v_control.approval_requested_at is null
    or v_control.approval_due_at
      <> v_control.approval_requested_at + interval '24 hours'
    or v_control.approval_decided_at is not null
    or v_control.approval_decided_by is not null
    or v_control.approval_rejection_reason is not null then
    raise exception 'minimal ZH approval state is invalid';
  end if;
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = v_user_id
      and profile.preferred_locale = 'zh'
      and profile.name = ''
      and profile.surname = ''
      and profile.job = ''
      and profile.organization = ''
      and profile.phone_country_iso2 is null
      and profile.phone_e164 is null
      and profile.avatar_updated_at is null
      and profile.onboarding_completed_at is null
  ) then
    raise exception 'minimal ZH registration unexpectedly required profile/contact data';
  end if;
  if (
    select count(*)
    from public.legal_acceptances acceptance
    where acceptance.user_id = v_user_id
      and acceptance.source = 'registration'
  ) <> 2 then
    raise exception 'minimal ZH registration did not retain current legal acceptance';
  end if;
  if not exists (
    select 1
    from private.zh_username_accounts account
    where account.user_id = v_user_id
      and account.username = 'zhminimal001'
      and account.synthetic_email = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb@auth.invalid'
  ) then
    raise exception 'minimal ZH registration did not retain the private username mapping';
  end if;
  if not private.authorize_zh_username_password_session(v_user_id, v_user_session_id) then
    raise exception 'minimal ZH fixture could not establish its bound username session';
  end if;

  select event.payload into v_event_payload
  from private.notification_events event
  where event.event_type = 'account.approval_requested'
    and event.aggregate_id = v_user_id;
  if v_event_payload is null
    or v_event_payload ->> 'locale' <> 'zh'
    or v_event_payload ? 'username'
    or v_event_payload ? 'email'
    or v_event_payload ? 'phoneCountryIso2'
    or v_event_payload ? 'phoneE164'
    or v_event_payload ? 'credential'
    or v_event_payload::text like '%@auth.invalid%' then
    raise exception 'generic ZH approval notification is missing or leaked sensitive data: %',
      v_event_payload;
  end if;

  -- A mapped ZH session still sees the synthetic email as null and receives
  -- the pending state instead of a fabricated completed profile.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user_id,
      'safetyhub_auth_kind', 'zh_username_password',
      'session_id', v_user_session_id
    )::text,
    true
  );
  select to_jsonb(context_row) into v_context
  from public.get_auth_context() context_row;
  if v_context -> 'email' <> 'null'::jsonb
    or v_context ->> 'approval_state' <> 'pending'
    or v_context ->> 'profile_preferred_locale' <> 'zh'
    or v_context -> 'profile_onboarding_completed_at' <> 'null'::jsonb then
    raise exception 'minimal ZH auth projection is invalid: %', v_context;
  end if;

  -- Provide disposable non-RU localizations for a seeded published course.
  -- Learner checks exercise public locale-aware RPCs while staying independent
  -- of release-content publication order. No answer key is returned to any
  -- learner payload.
  select test.slug, revision.id
  into v_test_slug, v_revision_id
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  join public.test_revision_localizations localization
    on localization.revision_id = revision.id
   and localization.locale = 'ru'
  where test.status = 'published'
    and exists (
      select 1
      from public.test_revision_variant_localizations variant_localization
      where variant_localization.revision_id = revision.id
        and variant_localization.locale = 'ru'
    )
  order by test.slug
  limit 1;
  if v_test_slug is null or v_revision_id is null then
    raise exception 'a seeded published RU course is required for minimal ZH learner coverage';
  end if;
  insert into public.test_revision_localizations (
    revision_id, locale, title, description, content, seo, sources,
    content_hash, translation_qa, published_at, published_by
  )
  select
    localization.revision_id,
    locale_fixture.locale,
    case locale_fixture.locale
      when 'zh'::public.app_locale then 'ZH minimal learner fixture'
      else localization.title
    end,
    localization.description,
    localization.content,
    localization.seo,
    localization.sources,
    localization.content_hash,
    localization.translation_qa,
    localization.published_at,
    localization.published_by
  from public.test_revision_localizations localization
  cross join unnest(array[
    'kk'::public.app_locale,
    'en'::public.app_locale,
    'zh'::public.app_locale
  ]) locale_fixture(locale)
  where localization.revision_id = v_revision_id
    and localization.locale = 'ru'
  on conflict (revision_id, locale) do nothing;
  insert into public.test_revision_variant_localizations (
    revision_id, variant_id, locale, questions, explanations, question_count,
    structure_hash, content_hash, created_at
  )
  select
    localization.revision_id,
    localization.variant_id,
    locale_fixture.locale,
    localization.questions,
    localization.explanations,
    localization.question_count,
    localization.structure_hash,
    localization.content_hash,
    localization.created_at
  from public.test_revision_variant_localizations localization
  cross join unnest(array[
    'kk'::public.app_locale,
    'en'::public.app_locale,
    'zh'::public.app_locale
  ]) locale_fixture(locale)
  where localization.revision_id = v_revision_id
    and localization.locale = 'ru'
  on conflict (variant_id, locale) do nothing;

  -- The exception is not email-null or locale-only. An otherwise approved,
  -- legal ordinary account remains subject to its normal profile/avatar gate
  -- in each non-ZH learner locale because it has no private ZH mapping.
  update public.account_controls
  set approval_state = 'approved'
  where user_id = v_ordinary_user_id;
  insert into public.legal_acceptances(
    user_id, document_type, version, accepted_at, source
  ) values
    (v_ordinary_user_id, 'privacy', v_privacy.version, statement_timestamp(), 'profile'),
    (v_ordinary_user_id, 'terms', v_terms.version, statement_timestamp(), 'profile');
  if exists (
    select 1 from private.zh_username_accounts account where account.user_id = v_ordinary_user_id
  ) then
    raise exception 'ordinary profile fixture unexpectedly owns a ZH username mapping';
  end if;
  perform set_config('request.jwt.claim.sub', v_ordinary_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_ordinary_user_id)::text,
    true
  );
  for v_ordinary_locale in
    select unnest(array[
      'ru'::public.app_locale,
      'kk'::public.app_locale,
      'en'::public.app_locale
    ])
  loop
    if v_ordinary_locale = 'ru'::public.app_locale then
      update public.profiles
      set preferred_locale = v_ordinary_locale,
          name = 'Обычный',
          surname = 'Ученик',
          job = 'Специалист',
          organization = 'SafetyHub minimal-ZH test',
          onboarding_completed_at = statement_timestamp(),
          avatar_updated_at = null
      where id = v_ordinary_user_id;
    else
      -- Leave the RU fixture's canonical organization untouched. The
      -- organization-directory trigger rejects an empty string; the ordinary
      -- account is nevertheless incomplete because its required name/job and
      -- onboarding state below are absent.
      update public.profiles
      set preferred_locale = v_ordinary_locale,
          name = '',
          surname = '',
          job = '',
          onboarding_completed_at = null,
          avatar_updated_at = null
      where id = v_ordinary_user_id;
    end if;
    v_expected_error := case
      when v_ordinary_locale = 'ru'::public.app_locale then 'AVATAR_REQUIRED'
      else 'PROFILE_ONBOARDING_REQUIRED'
    end;
    v_result := public.start_test_attempt_locale(v_test_slug, v_ordinary_locale);
    if v_result ->> 'error' <> v_expected_error then
      raise exception 'ordinary % account bypassed its profile/avatar gate: %',
        v_ordinary_locale::text, v_result;
    end if;
  end loop;

  -- Restore the original mapped learner before testing the pending decision.
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user_id,
      'safetyhub_auth_kind', 'zh_username_password',
      'session_id', v_user_session_id
    )::text,
    true
  );

  -- Pending accounts remain at the existing approval gate even if they own a
  -- valid ZH mapping and legal acceptance. The dedicated minimal exception is
  -- unavailable until an administrator makes an explicit approval decision.
  begin
    perform public.start_test_attempt_locale(v_test_slug, 'zh');
    raise exception 'pending minimal ZH account unexpectedly started a learner attempt';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ACCOUNT_APPROVAL_REQUIRED' then
        raise;
      end if;
      v_pending_start_blocked := true;
  end;
  if not v_pending_start_blocked then
    raise exception 'pending minimal ZH account did not retain the approval gate';
  end if;

  -- The queue remains identity.manage-gated. It may display the canonical
  -- username only after the existing provider-email redactor has run.
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_admin_id)::text,
    true
  );
  v_result := public.list_pending_account_approval_page(25, null, null);
  select item.value into v_queue_item
  from jsonb_array_elements(v_result -> 'items') item(value)
  where item.value ->> 'id' = v_user_id::text;
  if v_queue_item is null
    or v_queue_item -> 'email' <> 'null'::jsonb
    or v_queue_item ->> 'username' <> 'zhminimal001'
    or v_queue_item ->> 'name' <> ''
    or v_queue_item ->> 'surname' <> ''
    or v_queue_item ->> 'job' <> ''
    or v_queue_item ->> 'organization' <> ''
    or v_queue_item -> 'phoneE164' <> 'null'::jsonb then
    raise exception 'minimal ZH queue projection is invalid: %', v_queue_item;
  end if;

  v_result := public.decide_account_approval(
    '7b000000-0000-4000-8000-000000000003',
    v_user_id,
    'approved',
    null
  );
  if v_result ->> 'approvalState' <> 'approved' then
    raise exception 'administrator could not approve the minimal ZH application: %', v_result;
  end if;

  -- Approval opens the normal public learner RPC without inventing ordinary
  -- profile or avatar data. Completion must retain the normal attestation and
  -- certificate-identity boundary: a username is never a certificate name.
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_user_id,
      'safetyhub_auth_kind', 'zh_username_password',
      'session_id', v_user_session_id
    )::text,
    true
  );
  v_result := public.start_test_attempt_locale(v_test_slug, 'zh');
  v_attempt_id := (v_result ->> 'attemptId')::uuid;
  if v_result ? 'error'
    or v_attempt_id is null
    or v_result ->> 'status' <> 'started'
    or v_result ->> 'locale' <> 'zh'
    or coalesce(jsonb_array_length(v_result -> 'questions'), 0) <> 10 then
    raise exception 'approved minimal ZH account could not start a localized attempt: %', v_result;
  end if;
  if not exists (
    select 1
    from public.profiles profile
    where profile.id = v_user_id
      and profile.name = ''
      and profile.surname = ''
      and profile.job = ''
      and profile.organization = ''
      and profile.avatar_updated_at is null
      and profile.onboarding_completed_at is null
  ) then
    raise exception 'learner access fabricated ordinary ZH profile or avatar state';
  end if;

  select attempt.variant_id into v_variant_id
  from public.test_attempts attempt
  where attempt.id = v_attempt_id
    and attempt.user_id = v_user_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'questionId', question.value ->> 'id',
    'optionId', answer_key.correct_option_ids
      ->> (question.ordinality::integer - 1)
  ) order by question.ordinality), '[]'::jsonb)
  into v_answers
  from public.test_revision_variants variant
  join private.test_revision_variant_answer_keys answer_key
    on answer_key.variant_id = variant.id
   and answer_key.revision_id = variant.revision_id
  cross join lateral jsonb_array_elements(variant.questions)
    with ordinality question(value, ordinality)
  where variant.id = v_variant_id;
  if v_variant_id is null or coalesce(jsonb_array_length(v_answers), 0) <> 10 then
    raise exception 'minimal ZH attempt fixture could not build a complete answer set';
  end if;

  v_result := public.complete_test_attempt(v_attempt_id, v_answers);
  if v_result ? 'error'
    or v_result ->> 'status' <> 'passed'
    or v_result ->> 'locale' <> 'zh'
    or v_result ->> 'certificateId' is not null
    or v_result ->> 'certificatePendingVerification' <> 'true' then
    raise exception 'minimal ZH passed-attempt certificate boundary is invalid: %', v_result;
  end if;
  select attestation.id into v_attestation_id
  from public.attestations attestation
  where attestation.user_id = v_user_id
    and attestation.best_attempt_id = v_attempt_id;
  if v_attestation_id is null
    or exists (
      select 1 from public.certificates certificate where certificate.user_id = v_user_id
    ) then
    raise exception 'minimal ZH pass did not retain attestation-only certificate state';
  end if;
  begin
    perform private.issue_certificate_for_attestation(
      v_attestation_id,
      null,
      'manual'::public.certificate_issue_source,
      null,
      null
    );
    raise exception 'minimal ZH account unexpectedly received a certificate without identity';
  exception
    when object_not_in_prerequisite_state then
      if sqlerrm <> 'IDENTITY_NOT_VERIFIED' then
        raise;
      end if;
      v_certificate_blocked := true;
  end;
  if not v_certificate_blocked then
    raise exception 'minimal ZH certificate identity gate was not preserved';
  end if;

  -- A separately registered mapped account is rejected through the normal
  -- admin decision RPC. Rejection must retain the same public learner gate;
  -- the private mapping alone never grants course access.
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'service_role')::text,
    true
  );
  v_result := public.complete_zh_username_registration(
    v_rejected_user_id,
    'zhminimal002',
    'cccccccccccccccccccccccccccccccc@auth.invalid',
    v_privacy.version,
    v_privacy.body_revision,
    v_terms.version,
    v_terms.body_revision
  );
  if v_result ->> 'approvalState' <> 'pending' then
    raise exception 'rejected minimal ZH fixture did not enter pending review: %', v_result;
  end if;
  if not private.authorize_zh_username_password_session(
    v_rejected_user_id,
    v_rejected_session_id
  ) then
    raise exception 'rejected minimal ZH fixture could not establish its bound username session';
  end if;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_admin_id)::text,
    true
  );
  v_result := public.decide_account_approval(
    '7b000000-0000-4000-8000-000000000006',
    v_rejected_user_id,
    'rejected',
    'Test rejection path'
  );
  if v_result ->> 'approvalState' <> 'rejected' then
    raise exception 'administrator could not reject the minimal ZH fixture: %', v_result;
  end if;
  perform set_config('request.jwt.claim.sub', v_rejected_user_id::text, true);
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', v_rejected_user_id,
      'safetyhub_auth_kind', 'zh_username_password',
      'session_id', v_rejected_session_id
    )::text,
    true
  );
  begin
    perform public.start_test_attempt_locale(v_test_slug, 'zh');
    raise exception 'rejected minimal ZH account unexpectedly started a learner attempt';
  exception
    when insufficient_privilege then
      if sqlerrm <> 'ACCOUNT_APPROVAL_REQUIRED' then
        raise;
      end if;
      v_rejected_start_blocked := true;
  end;
  if not v_rejected_start_blocked then
    raise exception 'rejected minimal ZH account did not retain the approval gate';
  end if;
end;
$contract$;

rollback;
