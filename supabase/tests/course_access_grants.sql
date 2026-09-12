begin;

do $test$
declare
  v_actor_id uuid := '74000000-0000-4000-8000-000000000001';
  v_granted_user_id uuid := '74000000-0000-4000-8000-000000000002';
  v_ungranted_user_id uuid := '74000000-0000-4000-8000-000000000003';
  v_requested_at timestamptz := statement_timestamp();
  v_test_id uuid;
  v_test_slug text;
  v_other_test_id uuid;
  v_decision jsonb;
  v_replay jsonb;
  v_access jsonb;
  v_blocked boolean;
  v_procedure regprocedure;
  v_definition text;
begin
  if to_regclass('public.course_access_grants') is null
    or to_regprocedure('private.has_course_access(uuid,uuid)') is null
    or to_regprocedure('private.require_course_access_by_slug(uuid,text)') is null
    or to_regprocedure('public.set_course_access(uuid,uuid[])') is null
    or to_regprocedure('public.decide_account_approval(uuid,uuid,text,text,uuid[])') is null then
    raise exception 'course access contract missing';
  end if;

  -- Browser roles never read or write the grant table directly.
  if has_table_privilege('anon', 'public.course_access_grants', 'select')
    or has_table_privilege('authenticated', 'public.course_access_grants', 'select')
    or has_table_privilege('authenticated', 'public.course_access_grants', 'insert')
    or has_function_privilege('anon', 'public.set_course_access(uuid,uuid[])', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.set_course_access(uuid,uuid[])', 'EXECUTE') then
    raise exception 'course access grant boundary invalid';
  end if;

  -- Both learner entry points ask for the course grant after the account gate.
  foreach v_procedure in array array[
    'public.start_test_attempt_locale(text,public.app_locale)'::regprocedure,
    'public.get_approved_course_presentation_locale(text,text,public.app_locale)'::regprocedure
  ] loop
    v_definition := lower(pg_get_functiondef(v_procedure));
    if position('private.require_course_access_by_slug(' in v_definition) = 0
      or position('private.require_approved_learner()' in v_definition) = 0 then
      raise exception 'course access gate missing from %', v_procedure::text;
    end if;
  end loop;

  select test.id, test.slug into v_test_id, v_test_slug
  from public.tests test
  where test.status = 'published'
  order by test.display_order, test.id
  limit 1;
  if not found then
    raise notice 'course access regression: published course seed absent; skipping behaviour checks';
    return;
  end if;
  select test.id into v_other_test_id
  from public.tests test
  where test.id <> v_test_id
  order by test.display_order, test.id
  limit 1;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_actor_id,
      'authenticated', 'authenticated', 'course-access-actor@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_granted_user_id,
      'authenticated', 'authenticated', 'course-access-granted@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_ungranted_user_id,
      'authenticated', 'authenticated', 'course-access-ungranted@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  update public.user_roles
  set role = 'admin'
  where user_id = v_actor_id;

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_requested_at + interval '24 hours',
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id in (v_granted_user_id, v_ungranted_user_id);

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor_id::text, true);

  -- Approving with a course list opens exactly those courses.
  v_decision := public.decide_account_approval(
    '75000000-0000-4000-8000-000000000001',
    v_granted_user_id,
    'approved',
    null,
    array[v_test_id]
  );
  if (v_decision ->> 'approvalState') is distinct from 'approved'
    or (v_decision -> 'grantedCourseIds') is distinct from to_jsonb(array[v_test_id]) then
    raise exception 'approval with courses did not report the granted course: %', v_decision;
  end if;
  if not private.has_course_access(v_granted_user_id, v_test_id) then
    raise exception 'approval with courses did not store the grant';
  end if;

  -- A replay with the same key and courses is the same decision; a different
  -- course list under the same key is a reused key.
  v_replay := public.decide_account_approval(
    '75000000-0000-4000-8000-000000000001',
    v_granted_user_id,
    'approved',
    null,
    array[v_test_id]
  );
  if (v_replay ->> 'replayed')::boolean is not true then
    raise exception 'same-course replay was not recognised: %', v_replay;
  end if;
  begin
    perform public.decide_account_approval(
      '75000000-0000-4000-8000-000000000001',
      v_granted_user_id,
      'approved',
      null,
      '{}'::uuid[]
    );
    raise exception 'a different course list replayed under a used idempotency key';
  exception when others then
    if sqlerrm <> 'IDEMPOTENCY_KEY_REUSED' then
      raise;
    end if;
  end;

  -- The four-argument form still approves, but opens nothing.
  v_decision := public.decide_account_approval(
    '75000000-0000-4000-8000-000000000002',
    v_ungranted_user_id,
    'approved',
    null
  );
  if (v_decision ->> 'approvalState') is distinct from 'approved' then
    raise exception 'legacy approval form failed: %', v_decision;
  end if;
  if private.has_course_access(v_ungranted_user_id, v_test_id) then
    raise exception 'approval without courses opened a course';
  end if;

  -- The gate: an approved learner without a grant is refused by name; one with
  -- the grant passes; an administrator always passes.
  v_blocked := false;
  begin
    perform private.require_course_access_by_slug(v_ungranted_user_id, v_test_slug);
  exception when others then
    v_blocked := sqlerrm = 'COURSE_ACCESS_REQUIRED';
  end;
  if not v_blocked then
    raise exception 'approved learner without a grant passed the course gate';
  end if;
  perform private.require_course_access_by_slug(v_granted_user_id, v_test_slug);
  perform private.require_course_access_by_slug(v_actor_id, v_test_slug);
  -- An unknown slug is the caller''s not-found, never a leak through this gate.
  perform private.require_course_access_by_slug(v_ungranted_user_id, 'no-such-course-slug');

  -- Replacing the set revokes what is not listed and opens what is.
  v_access := public.set_course_access(v_ungranted_user_id, array[v_test_id]);
  if not private.has_course_access(v_ungranted_user_id, v_test_id) then
    raise exception 'set_course_access did not open the listed course: %', v_access;
  end if;
  if v_other_test_id is not null then
    v_access := public.set_course_access(v_ungranted_user_id, array[v_other_test_id]);
    if private.has_course_access(v_ungranted_user_id, v_test_id)
      or not private.has_course_access(v_ungranted_user_id, v_other_test_id) then
      raise exception 'set_course_access did not replace the set: %', v_access;
    end if;
  end if;
  v_access := public.set_course_access(v_ungranted_user_id, '{}'::uuid[]);
  if exists (
    select 1 from public.course_access_grants grant_row
    where grant_row.user_id = v_ungranted_user_id
  ) then
    raise exception 'set_course_access with an empty list left grants behind';
  end if;
  if not exists (
    select 1 from public.admin_audit_log log
    where log.target_user_id = v_ungranted_user_id
      and log.action = 'course.access.changed'
  ) then
    raise exception 'course access change was not audited';
  end if;

  -- An unknown course id is refused before anything is written.
  begin
    perform public.set_course_access(
      v_ungranted_user_id, array['00000000-0000-4000-8000-00000000dead'::uuid]
    );
    raise exception 'set_course_access accepted an unknown course';
  exception when others then
    if sqlerrm <> 'COURSE_ACCESS_COURSE_UNKNOWN' then
      raise;
    end if;
  end;
end;
$test$;

-- Phone became optional: an empty pair is stored as null, a half pair or a
-- malformed number is still refused.
do $test$
declare
  v_definition text;
begin
  v_definition := lower(pg_get_functiondef(
    'public.submit_profile_for_approval_from_trusted_server(uuid,text,text,text,text,text,text)'::regprocedure
  ));
  if position('(v_phone_country_iso2 is null) <> (v_phone_e164 is null)' in v_definition) = 0
    or position('profile_phone_invalid' in v_definition) = 0
    or position('profile_fields_required' in v_definition) = 0 then
    raise exception 'profile submission must keep name/job/company required and phone optional';
  end if;
end;
$test$;

rollback;
