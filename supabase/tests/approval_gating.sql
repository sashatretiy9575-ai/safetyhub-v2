begin;

do $test$
declare
  v_pending_user_id uuid := '30000000-0000-4000-8000-000000000001';
  v_rejected_user_id uuid := '30000000-0000-4000-8000-000000000002';
  v_approved_user_id uuid := '30000000-0000-4000-8000-000000000003';
  v_missing_attempt_id uuid := '30000000-0000-4000-8000-000000000004';
  v_expired_attempt_id uuid := '30000000-0000-4000-8000-000000000005';
  v_requested_at timestamptz := statement_timestamp();
  v_procedure regprocedure;
  v_definition text;
  v_blocked boolean;
  v_legal_blocked boolean;
  v_reached_attempt_lookup boolean := false;
  v_revision_id uuid;
  v_test_id uuid;
  v_variant_id uuid;
  v_duration_minutes integer;
  v_pass_score integer;
  v_attempts_per_day integer;
  v_reset_timezone text;
begin
  -- The trigger creates profiles, roles and active controls; these focused rows
  -- then exercise the exact approval states without needing a course fixture.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_pending_user_id,
      'authenticated', 'authenticated', 'approval-pending@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_rejected_user_id,
      'authenticated', 'authenticated', 'approval-rejected@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_approved_user_id,
      'authenticated', 'authenticated', 'approval-approved@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours',
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_pending_user_id;

  update public.account_controls
  set approval_state = 'rejected',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours',
      approval_decided_at = v_requested_at,
      approval_decided_by = null,
      approval_rejection_reason = 'Test rejection reason'
  where user_id = v_rejected_user_id;

  update public.account_controls
  set approval_state = 'approved',
      approval_requested_at = null,
      approval_due_at = null,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_approved_user_id;

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
  if not found then
    raise exception 'approval/legal regression requires one seeded course variant';
  end if;

  insert into public.test_attempts (
    id, user_id, revision_id, test_id, variant_id, locale,
    duration_minutes, pass_score, attempts_per_day, reset_timezone,
    started_at, expires_at
  ) values (
    v_expired_attempt_id, v_approved_user_id, v_revision_id, v_test_id,
    v_variant_id, 'ru', v_duration_minutes, v_pass_score,
    v_attempts_per_day, v_reset_timezone,
    statement_timestamp() - make_interval(mins => v_duration_minutes + 1),
    statement_timestamp() - interval '1 minute'
  );

  -- A direct definition check covers each browser-callable attempt entry point.
  foreach v_procedure in array array[
    'public.start_test_attempt(text)'::regprocedure,
    'public.resume_test_attempt(text)'::regprocedure,
    'public.get_test_attempt(uuid)'::regprocedure,
    'public.complete_test_attempt(uuid,jsonb)'::regprocedure,
    'public.get_approved_course_presentation(text,text)'::regprocedure,
    'public.get_approved_course_presentation_locale(text,text,public.app_locale)'::regprocedure
  ] loop
    v_definition := lower(pg_get_functiondef(v_procedure));
    if position('private.require_approved_learner()' in v_definition) = 0 then
      raise exception 'approval gate missing from %', v_procedure::text;
    end if;
  end loop;

  -- Direct PostgREST SELECTs must not bypass the question-returning RPC. The
  -- v3 variant bank has no browser grants, while legacy revisions must withhold
  -- both the question bank and course material after the metadata-only grant.
  if has_table_privilege('anon', 'public.test_revision_variants', 'select')
    or has_table_privilege('authenticated', 'public.test_revision_variants', 'select')
    or has_column_privilege('anon', 'public.test_revision_variants', 'questions', 'select')
    or has_column_privilege('authenticated', 'public.test_revision_variants', 'questions', 'select')
    or has_column_privilege('anon', 'public.test_revisions', 'questions', 'select')
    or has_column_privilege('authenticated', 'public.test_revisions', 'questions', 'select')
    or has_column_privilege('anon', 'public.test_revisions', 'content', 'select')
    or has_column_privilege('authenticated', 'public.test_revisions', 'content', 'select') then
    raise exception 'browser role can bypass approved learner question/content gate';
  end if;

  -- pending and rejected accounts must be stopped before a missing attempt can
  -- be looked up; this proves the question-returning RPC's authorization order.
  foreach v_procedure in array array[
    'public.get_test_attempt(uuid)'::regprocedure
  ] loop
    perform set_config('request.jwt.claim.role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_pending_user_id::text, true);
    v_blocked := false;
    begin
      perform public.get_test_attempt(v_missing_attempt_id);
    exception when insufficient_privilege then
      if sqlerrm = 'ACCOUNT_APPROVAL_REQUIRED' then
        v_blocked := true;
      else
        raise;
      end if;
    end;
    if not v_blocked then
      raise exception 'pending learner bypassed attempt approval gate';
    end if;

    perform set_config('request.jwt.claim.sub', v_rejected_user_id::text, true);
    v_blocked := false;
    begin
      perform public.get_test_attempt(v_missing_attempt_id);
    exception when insufficient_privilege then
      if sqlerrm = 'ACCOUNT_APPROVAL_REQUIRED' then
        v_blocked := true;
      else
        raise;
      end if;
    end;
    if not v_blocked then
      raise exception 'rejected learner bypassed attempt approval gate';
    end if;
  end loop;

  -- Approval without both current legal acceptances must stop direct RPC calls
  -- before an expired attempt is mutated or the completion quota is consumed.
  perform set_config('request.jwt.claim.sub', v_approved_user_id::text, true);
  v_legal_blocked := false;
  begin
    perform public.get_test_attempt(v_expired_attempt_id);
  exception when sqlstate '55000' then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_legal_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legal_blocked then
    raise exception 'approved learner without current legal acceptance bypassed get gate';
  end if;
  if (select status from public.test_attempts where id = v_expired_attempt_id)
    is distinct from 'started'::public.attempt_status then
    raise exception 'legal rejection mutated the expired attempt';
  end if;

  v_legal_blocked := false;
  begin
    perform public.complete_test_attempt(v_expired_attempt_id, '[]'::jsonb);
  exception when sqlstate '55000' then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_legal_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legal_blocked then
    raise exception 'approved learner without current legal acceptance bypassed complete gate';
  end if;
  if exists (
    select 1 from private.business_rate_limits rate
    where rate.actor_id = v_approved_user_id and rate.action = 'attempt.complete'
  ) then
    raise exception 'legal rejection consumed the completion quota';
  end if;
  if exists (
    select 1 from public.attestations attestation
    where attestation.user_id = v_approved_user_id
  ) or exists (
    select 1 from public.certificates certificate
    where certificate.user_id = v_approved_user_id
  ) then
    raise exception 'legal rejection created learner completion artifacts';
  end if;

  v_legal_blocked := false;
  begin
    perform public.get_approved_course_presentation(
      'missing-presentation-course', 'presentation'
    );
  exception when sqlstate '55000' then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_legal_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legal_blocked then
    raise exception 'approved learner without current legal acceptance reached presentation lookup';
  end if;

  v_legal_blocked := false;
  begin
    perform public.get_approved_course_presentation_locale(
      'missing-presentation-course', 'presentation', 'ru'
    );
  exception when sqlstate '55000' then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_legal_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legal_blocked then
    raise exception 'approved learner without current legal acceptance reached localized presentation lookup';
  end if;

  insert into public.legal_acceptances (
    user_id, document_type, version, source
  )
  select v_approved_user_id, document.document_type, document.version, 'profile'
  from public.legal_document_versions document
  where document.is_current
    and document.document_type in ('privacy', 'terms')
  on conflict do nothing;

  -- After accepting both current documents, the approved account reaches the
  -- ordinary attempt lookup instead of either authorization guard.
  begin
    perform public.get_test_attempt(v_missing_attempt_id);
  exception when no_data_found then
    if sqlerrm = 'ATTEMPT_NOT_FOUND' then
      v_reached_attempt_lookup := true;
    else
      raise;
    end if;
  end;
  if not v_reached_attempt_lookup then
    raise exception 'approved learner did not pass attempt approval gate';
  end if;
end;
$test$;

rollback;
