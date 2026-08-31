begin;

do $test$
declare
  v_pending_user_id uuid := '30000000-0000-4000-8000-000000000001';
  v_rejected_user_id uuid := '30000000-0000-4000-8000-000000000002';
  v_approved_user_id uuid := '30000000-0000-4000-8000-000000000003';
  v_missing_attempt_id uuid := '30000000-0000-4000-8000-000000000004';
  v_requested_at timestamptz := statement_timestamp();
  v_procedure regprocedure;
  v_definition text;
  v_blocked boolean;
  v_reached_attempt_lookup boolean := false;
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

  -- A direct definition check covers each browser-callable attempt entry point.
  foreach v_procedure in array array[
    'public.start_test_attempt(text)'::regprocedure,
    'public.resume_test_attempt(text)'::regprocedure,
    'public.get_test_attempt(uuid)'::regprocedure,
    'public.complete_test_attempt(uuid,jsonb)'::regprocedure,
    'public.get_approved_course_presentation(text,text)'::regprocedure
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

  -- Approved reaches ordinary domain validation instead of the approval guard.
  perform set_config('request.jwt.claim.sub', v_approved_user_id::text, true);
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
