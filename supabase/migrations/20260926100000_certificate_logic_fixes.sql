-- Certificate and attempt logic, as the September audit found it.
--
-- 1. A better score whose reissue the documents refuse keeps the result, as
--    before, but the refusal is now written to «История действий» with its
--    reason, and a lock that was not granted in time is retried rather than
--    taken for a refusal.
-- 2. A course closed to a learner closes their open attempt as well: the
--    submission and the attempt read refuse it, and changing the course set
--    expires the attempts of the courses taken away.
-- 3. The sitting of a course is counted over every certificate of the course,
--    whatever slug the revision a learner sat carried before a rename.
-- 4. The public check shows the date printed on the document and says a
--    document is revoked when it was withdrawn without a replacement, when the
--    holder's identity was revoked or when the account is suspended.
-- 5. The year in a certificate number is the year in Oral, like its date.
-- 6. A date chosen for the documents cannot precede the examination, and a
--    journal number chosen for an electrical sheet is refused when the journal
--    has already passed it instead of being quietly replaced.
-- 7. The learner's dashboard says which courses are open to them.

-- 1. «История действий» keeps a refused reissue ------------------------------

create or replace function private.audit_event_allowed(p_action text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_action in (
    'account.approval.approved',
    'course.access.changed',
    'test.passed',
    'certificate.issued',
    'certificate.reissue_refused',
    'user.self_delete_requested',
    'user.purged',
    'user.self_purged',
    'role.changed',
    'role.changed_directly',
    'admin.provisioned_by_email',
    'superadmin.bootstrapped',
    'admin.break_glass_restored'
  );
$$;

revoke all on function private.audit_event_allowed(text)
  from public, anon, authenticated, service_role;

create or replace function private.complete_test_attempt_unmetered(
  p_attempt_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_key private.test_revision_variant_answer_keys%rowtype;
  v_answers smallint[] := '{}'::smallint[];
  v_score integer := 0;
  v_matched_questions integer := 0;
  v_matched_options integer := 0;
  v_became_best boolean := false;
  v_attestation_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_batch_id uuid := gen_random_uuid();
  v_refusal_state text;
  v_refusal_message text;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_ANSWERS';
  end if;
  if jsonb_array_length(p_answers) > 100 or pg_column_size(p_answers) > 65536 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_ANSWERS_TOO_LARGE';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attempt
  from public.test_attempts
  where id = p_attempt_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status in ('passed', 'failed') then
    return private.attempt_payload(v_attempt.id);
  end if;
  if v_attempt.status = 'expired' or v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = coalesce(completed_at, statement_timestamp())
    where id = v_attempt.id;
    return private.attempt_payload(v_attempt.id);
  end if;
  -- The course was closed to the learner while the attempt was open: nothing
  -- is recorded. Checked under the learner's lock, which a change of the
  -- course set takes as well, so the two cannot pass each other.
  if not private.has_course_access(v_user_id, v_attempt.test_id) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'COURSE_ACCESS_REQUIRED';
  end if;

  select * into v_revision
  from public.test_revisions where id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id
    and variant.revision_id = v_attempt.revision_id;
  select * into v_key
  from private.test_revision_variant_answer_keys answer_key
  where answer_key.variant_id = v_attempt.variant_id
    and answer_key.revision_id = v_attempt.revision_id;
  if v_variant.id is null or v_key.variant_id is null
    or jsonb_array_length(v_key.correct_option_ids) <> v_variant.question_count then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  if jsonb_array_length(p_answers) <> v_variant.question_count
    or (select count(distinct item ->> 'questionId')
        from jsonb_array_elements(p_answers) item)
      <> v_variant.question_count then
    raise exception using errcode = 'check_violation',
      message = 'DUPLICATE_OR_MISSING_QUESTION_ANSWER';
  end if;

  with submitted as (
    select item ->> 'questionId' as question_id,
      item ->> 'optionId' as option_id
    from jsonb_array_elements(p_answers) item
  ), matched as (
    select
      question.ordinality::integer as question_position,
      submitted.question_id,
      submitted.option_id,
      option.ordinality::integer - 1 as option_position
    from jsonb_array_elements(v_variant.questions)
      with ordinality question(value, ordinality)
    left join submitted on submitted.question_id = question.value ->> 'id'
    left join lateral (
      select candidate.ordinality
      from jsonb_array_elements(question.value -> 'options')
        with ordinality candidate(value, ordinality)
      where candidate.value ->> 'id' = submitted.option_id
      limit 1
    ) option on true
  )
  select
    coalesce(array_agg(
      matched.option_position::smallint order by matched.question_position
    ) filter (where matched.option_position is not null), '{}'::smallint[]),
    count(*) filter (
      where matched.option_id
        = v_key.correct_option_ids ->> (matched.question_position - 1)
    )::integer,
    count(matched.question_id)::integer,
    count(matched.option_position)::integer
  into v_answers, v_score, v_matched_questions, v_matched_options
  from matched;

  if v_matched_questions <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_QUESTION';
  end if;
  if v_matched_options <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_OPTION';
  end if;

  update public.test_attempts
  set answers = v_answers,
      score = v_score,
      status = case
        when v_score >= v_attempt.pass_score then 'passed'::public.attempt_status
        else 'failed'::public.attempt_status
      end,
      completed_at = statement_timestamp()
  where id = v_attempt.id
  returning * into v_attempt;

  -- A failed result remains an attempt only. Attestations (and therefore any
  -- certificate workflow) begin exclusively at the passing threshold.
  if v_attempt.status <> 'passed' then
    return private.attempt_payload(v_attempt.id);
  end if;

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, batch_id
  ) values (
    null, v_attempt.user_id, 'test.passed', 'attempt', v_attempt.id::text,
    jsonb_build_object(
      'score', v_attempt.score,
      'passScore', v_attempt.pass_score,
      'revisionId', v_attempt.revision_id
    ),
    v_batch_id
  );

  insert into public.attestations (
    user_id, revision_id, best_attempt_id, best_score, best_completed_at
  ) values (
    v_attempt.user_id, v_attempt.revision_id, v_attempt.id,
    v_attempt.score, v_attempt.completed_at
  )
  on conflict (user_id, revision_id) do update
  set best_attempt_id = excluded.best_attempt_id,
      best_score = excluded.best_score,
      best_completed_at = excluded.best_completed_at,
      updated_at = statement_timestamp()
  where excluded.best_score > public.attestations.best_score
     or (excluded.best_score = public.attestations.best_score
       and (excluded.best_completed_at, excluded.best_attempt_id)
         > (public.attestations.best_completed_at, public.attestations.best_attempt_id))
  returning id, best_attempt_id = v_attempt.id
  into v_attestation_id, v_became_best;

  if v_attestation_id is null then
    select id, best_attempt_id = v_attempt.id
    into v_attestation_id, v_became_best
    from public.attestations
    where user_id = v_attempt.user_id and revision_id = v_attempt.revision_id;
  end if;

  if v_became_best then
    select * into v_active_certificate
    from public.certificates certificate
    where certificate.user_id = v_attempt.user_id
      and certificate.revision_id = v_attempt.revision_id
      and certificate.revoked_at is null
    for update;
    if found and v_attempt.score > v_active_certificate.score then
      -- The attempt and attestation above must survive any refusal to issue.
      -- This subtransaction restores both the old active certificate and its
      -- audit record; an administrator reissues from the employee card.
      begin
        update public.certificates
        set revoked_at = statement_timestamp(),
            revoked_by = null,
            revoke_reason = 'Результат улучшен'
        where id = v_active_certificate.id;
        insert into public.admin_audit_log (
          actor_user_id, target_user_id, action, target_type, target_id,
          after_data, reason, batch_id
        ) values (
          null, v_attempt.user_id, 'certificate.revoked', 'certificate',
          v_active_certificate.id::text,
          jsonb_build_object(
            'certificateNumber', v_active_certificate.certificate_number
          ),
          'Результат улучшен', v_batch_id
        );
        perform private.issue_certificate_for_attestation(
          v_attestation_id, null, 'score_improvement',
          v_active_certificate.id, v_batch_id
        );
      exception
        -- A transaction the server must retry is still retried, and so is a
        -- lock that was not granted in time: the learner submits again and the
        -- document is replaced then.
        when serialization_failure or deadlock_detected or lock_not_available then raise;
        -- Any refusal to issue the better document — a missing field, a
        -- recorded failed exam, a signature out of step, a full journal —
        -- leaves the earlier certificate standing and the result recorded.
        -- The refusal and its reason go to «История действий», where the
        -- administrator sees why the document was not replaced.
        when others then
          get stacked diagnostics
            v_refusal_state = returned_sqlstate,
            v_refusal_message = message_text;
          insert into public.admin_audit_log (
            actor_user_id, target_user_id, action, target_type, target_id,
            after_data, reason, batch_id
          ) values (
            null, v_attempt.user_id, 'certificate.reissue_refused', 'certificate',
            v_active_certificate.id::text,
            jsonb_build_object(
              'certificateId', v_active_certificate.id,
              'certificateNumber', v_active_certificate.certificate_number,
              'certificateScore', v_active_certificate.score,
              'attemptId', v_attempt.id,
              'score', v_attempt.score,
              'revisionId', v_attempt.revision_id,
              'sqlstate', v_refusal_state,
              'reason', left(coalesce(v_refusal_message, ''), 500)
            ),
            left(coalesce(v_refusal_message, ''), 500), v_batch_id
          );
      end;
    end if;
  end if;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.complete_test_attempt_unmetered(uuid,jsonb)
  from public, anon, authenticated, service_role;

-- 2. A closed course closes its attempts ------------------------------------

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
  -- The questions of a course that is no longer open are not handed out,
  -- the same answer the start of an attempt gives.
  if not private.has_course_access(v_user_id, v_attempt.test_id) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'COURSE_ACCESS_REQUIRED';
  end if;
  if v_attempt.status = 'started' and v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = statement_timestamp()
    where id = v_attempt.id and status = 'started' and expires_at <= statement_timestamp();
  end if;
  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function public.get_test_attempt(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_test_attempt(uuid) to authenticated;

create or replace function public.set_course_access(
  p_target_user_id uuid,
  p_course_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_course_ids uuid[] := (
    select coalesce(array_agg(distinct course_id order by course_id), '{}'::uuid[])
    from unnest(coalesce(p_course_ids, '{}'::uuid[])) as course_id
  );
  v_known_course_count integer;
  v_before uuid[];
  v_after uuid[];
begin
  if p_target_user_id is null or cardinality(v_course_ids) > 200 then
    raise exception using errcode = '22023', message = 'COURSE_ACCESS_REQUEST_INVALID';
  end if;
  if cardinality(v_course_ids) > 0 then
    select count(*) into v_known_course_count
    from public.tests test
    where test.id = any(v_course_ids);
    if v_known_course_count <> cardinality(v_course_ids) then
      raise exception using errcode = '22023', message = 'COURSE_ACCESS_COURSE_UNKNOWN';
    end if;
  end if;
  if not exists (
    select 1
    from public.account_controls control
    where control.user_id = p_target_user_id
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = '55000', message = 'ACCOUNT_UNAVAILABLE';
  end if;

  perform private.enforce_actor_quota('admin.identity.mutate');
  perform pg_advisory_xact_lock(hashtextextended(
    'safetyhub:course-access:' || p_target_user_id::text, 0
  ));
  -- The learner's own lock, the one an attempt is started and submitted
  -- under: a submission either finishes before the course is taken away or
  -- finds its attempt closed.
  perform pg_advisory_xact_lock(hashtextextended(p_target_user_id::text, 0));

  select coalesce(array_agg(grant_row.test_id order by grant_row.test_id), '{}'::uuid[])
    into v_before
  from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id;

  delete from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id
    and grant_row.test_id <> all(v_course_ids);

  insert into public.course_access_grants (user_id, test_id, granted_by)
  select p_target_user_id, course_id, v_actor_id
  from unnest(v_course_ids) as course_id
  on conflict (user_id, test_id) do nothing;

  select coalesce(array_agg(grant_row.test_id order by grant_row.test_id), '{}'::uuid[])
    into v_after
  from public.course_access_grants grant_row
  where grant_row.user_id = p_target_user_id;

  -- An attempt open on a course taken away ends here, unscored, as if its time
  -- had run out. An administrator keeps every course, so theirs stay open.
  update public.test_attempts attempt
  set status = 'expired', completed_at = statement_timestamp()
  where attempt.user_id = p_target_user_id
    and attempt.status = 'started'
    and attempt.test_id = any(v_before)
    and attempt.test_id <> all(v_after)
    and not private.has_course_access(p_target_user_id, attempt.test_id);

  if v_before is distinct from v_after then
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id, before_data, after_data
    ) values (
      v_actor_id,
      p_target_user_id,
      'course.access.changed',
      'course_access',
      p_target_user_id::text,
      jsonb_build_object('courseIds', to_jsonb(v_before)),
      jsonb_build_object('courseIds', to_jsonb(v_after))
    );
  end if;

  return private.ensure_rpc_payload(jsonb_build_object(
    'userId', p_target_user_id,
    'courseIds', to_jsonb(v_after)
  ));
end;
$$;

revoke all on function public.set_course_access(uuid, uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.set_course_access(uuid, uuid[]) to authenticated;

-- 3, 6. The sitting is the course's, whatever the slug of the revision --------

create or replace function private.capture_document_snapshot() returns trigger
language plpgsql security definer set search_path='' as $$
declare s jsonb; p public.document_profiles; d date;
 c_max_participants constant integer := 50;
 v_org text := lower(btrim(new.organization)); v_course text; v_audience text;
 v_base text; v_number text; v_previous public.certificates; v_family text; v_part integer;
 v_journal_max bigint; v_prior_max bigint;
 v_chosen_date text := nullif(current_setting('safetyhub.document_date', true), '');
 v_chosen_number text := nullif(btrim(current_setting('safetyhub.protocol_number', true)), '');
begin
 if tg_op='UPDATE' then
   if new.document_snapshot is distinct from old.document_snapshot then raise exception 'DOCUMENT_SNAPSHOT_IMMUTABLE'; end if;
   return new;
 end if;
 select private.certificate_settings_payload(false) into s;
 v_course := private.certificate_course_slug(new.revision_id, new.test_slug);
 -- One category: everybody is on it. «ИТР» and «рабочие»: the administrator's
 -- choice for the person, otherwise what the position says.
 select * into p from public.document_profiles where course_slug=v_course and audience='all';
 if p.id is null then
   v_audience := coalesce(
     (select document_audience from public.profiles where id=new.user_id),
     private.document_audience_for_position(new.job));
   select * into p from public.document_profiles where course_slug=v_course and audience=v_audience;
 end if;
 if exists(select 1 from public.document_profiles where course_slug=v_course) and p.id is null then
   raise exception using errcode='22023', message='DOCUMENT_PROFILE_REQUIRED';
 end if;
 if new.supersedes_certificate_id is not null then
   select * into v_previous from public.certificates where id=new.supersedes_certificate_id;
 end if;
 -- A sitting the administrator dates cannot precede the examination it records.
 if v_chosen_date is not null
   and v_chosen_date::date < (new.best_completed_at at time zone 'Asia/Oral')::date then
   raise exception using errcode='22023', message='DOCUMENT_DATE_BEFORE_EXAM';
 end if;
 -- The date the administrator chose when issuing; a corrected name or company
 -- stays on the sitting of the document it replaces; otherwise the day of issue.
 d:=coalesce(
   v_chosen_date::date,
   case when new.issue_source='identity_correction' then (v_previous.document_snapshot->>'protocolDate')::date end,
   (new.issued_at at time zone 'Asia/Oral')::date);
 v_base:=coalesce(v_chosen_number,to_char(d,'DD.MM'));
 v_family:=coalesce(p.body->>'family','general');
 -- An electrical course keeps a journal: the number the centre's journal is at
 -- is stated once on the course, and every sheet takes the next free one.
 if v_family='electrical' and v_chosen_number is null
   and coalesce(p.body->'electrical'->>'journalStart','') ~ '^[1-9][0-9]{0,8}$' then
   v_base:=p.body->'electrical'->>'journalStart';
 end if;
 -- Every sheet below is looked for by the course it belongs to under its
 -- present name: a certificate records the slug of the revision it was sat
 -- on, and a renamed course has certificates under both slugs on one day.
 if v_family='electrical' then
   -- The journal of the course is one for every company, so the lock is too.
   perform pg_advisory_xact_lock(hashtextextended('protocol:electrical|'||v_course,0));
   -- A corrected document keeps the sheet it replaces; so does a person reissued
   -- on the same day.
   if v_chosen_number is null then
     if new.issue_source='identity_correction' and v_previous.id is not null then
       v_number:=v_previous.document_snapshot->>'protocolNumber';
     else
       select c.document_snapshot->>'protocolNumber' into v_number
       from public.certificates c
       where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
         and c.document_snapshot->>'protocolDate'=d::text
         and private.certificate_course_slug(c.revision_id, c.test_slug)=v_course
         and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
       order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
     end if;
   end if;
   if v_number is null then
     if v_base ~ '^[0-9]{1,9}$' then
       -- «128» runs on as the journal does: the next number after the highest
       -- this course has printed, and never below the one the journal starts
       -- from. The course is matched by its current slug, so a renamed course
       -- keeps counting from its old sheets.
       select max((c.document_snapshot->>'protocolNumber')::bigint),
              max((c.document_snapshot->>'protocolNumber')::bigint)
                filter (where c.issued_at < new.issued_at)
       into v_journal_max, v_prior_max
       from public.certificates c
       where c.document_snapshot->>'protocolNumber' ~ '^[0-9]{1,9}$'
         and private.certificate_course_slug(c.revision_id, c.test_slug) = v_course;
       -- A number the administrator typed is the sheet they mean. One the
       -- journal has already passed is refused rather than quietly replaced;
       -- the other people of the same issuance follow on from it.
       if v_chosen_number is not null and v_base::bigint <= coalesce(v_prior_max, 0) then
         raise exception using errcode='22023', message='PROTOCOL_NUMBER_TAKEN';
       end if;
       v_number:=greatest(v_base::bigint, coalesce(v_journal_max + 1, 0))::text;
     else
       select coalesce(max(private.protocol_part(c.document_snapshot->>'protocolNumber',v_base)),0)+1
       into v_part
       from public.certificates c
       where c.document_snapshot->>'protocolDate'=d::text
         and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
         and private.certificate_course_slug(c.revision_id, c.test_slug)=v_course;
       v_number:=case when v_part<=1 then v_base else v_base||'-'||v_part::text end;
     end if;
   end if;
 else
 -- One sitting at a time: two issuances for the same protocol must not both
 -- count forty-nine and both take the fiftieth place.
 perform pg_advisory_xact_lock(hashtextextended('protocol:'||v_org||'|'||v_course||'|'||d::text,0));
 -- A corrected document of the same company and category keeps its number.
 if new.issue_source='identity_correction' and v_chosen_number is null
   and v_previous.id is not null and lower(btrim(v_previous.organization))=v_org
   and v_previous.document_snapshot->>'protocolDate'=d::text
   and v_previous.document_snapshot#>>'{profile,id}' is not distinct from p.id then
   v_number:=v_previous.document_snapshot->>'protocolNumber';
 end if;
 -- A reissue on the same day stays on the protocol the person is already on.
 if v_number is null then
   select c.document_snapshot->>'protocolNumber' into v_number
   from public.certificates c
   where (c.id=new.supersedes_certificate_id or (c.user_id=new.user_id and c.revoked_at is null))
     and lower(btrim(c.organization))=v_org
     and c.document_snapshot->>'protocolDate'=d::text
     and c.document_snapshot#>>'{profile,id}' is not distinct from p.id
     and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
     and private.certificate_course_slug(c.revision_id, c.test_slug)=v_course
   order by (c.id=new.supersedes_certificate_id) desc, c.issued_at desc limit 1;
 end if;
 if v_number is null then
   -- «ИТР» and «рабочий состав» sit on protocols of their own, as the centre
   -- prints them: a protocol takes one listener category and at most fifty
   -- people. The person joins the last protocol of their category that still
   -- has room; otherwise the day's next number opens.
   with protocols as (
     select c.document_snapshot->>'protocolNumber' as num,
            c.document_snapshot#>>'{profile,id}' as profile_id,
            count(distinct c.user_id) filter (where c.revoked_at is null) as people,
            private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) as part
     from public.certificates c
     where lower(btrim(c.organization))=v_org
       and c.document_snapshot->>'protocolDate'=d::text
       and private.protocol_part(c.document_snapshot->>'protocolNumber',v_base) is not null
       and private.certificate_course_slug(c.revision_id, c.test_slug)=v_course
     group by 1,2
   )
   select coalesce(
     (select num from protocols
      where profile_id is not distinct from p.id and people<c_max_participants
      order by part desc limit 1),
     case when not exists(select 1 from protocols) then v_base
          else v_base||'-'||((select max(part) from protocols)+1)::text end)
   into v_number;
 end if;
 end if;
 new.document_snapshot:=jsonb_build_object(
   'schemaVersion',1,'captureKind','issuance','capturedAt',statement_timestamp(),
   'settings',s,
   'profile',private.complete_document_profile(
     case when p.id is null then null
       else p.body||jsonb_build_object('id',p.id,'courseSlug',p.course_slug,'audience',p.audience) end,
     (select document_commission from public.certificate_settings where singleton)),
   'profileVersion',p.version,
   'protocolNumber',v_number,'protocolDate',d,
   'education',coalesce((select education from public.profiles where id=new.user_id),''),
   'photo', (select jsonb_build_object('objectKey',object_key,'legacyImported',legacy_imported) from private.profile_avatar_manifests where user_id=new.user_id)
 );
 return new;
end; $$;

revoke all on function private.capture_document_snapshot() from public,anon,authenticated,service_role;

-- 5. The year of a certificate number is the year in Oral --------------------

create or replace function private.issue_certificate_for_attestation(
  p_attestation_id uuid,
  p_actor_id uuid,
  p_source public.certificate_issue_source,
  p_supersedes uuid default null,
  p_batch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attestation public.attestations%rowtype;
  v_revision public.test_revisions%rowtype;
  v_attempt public.test_attempts%rowtype;
  v_localization public.test_revision_localizations%rowtype;
  v_identity public.verified_identities%rowtype;
  v_certificate_id uuid;
  v_number text;
  v_user_id uuid;
  v_full_name text;
  v_account_status public.account_status;
  v_account_deleting boolean;
begin
  -- Two very different situations used to share one code. An operator who had
  -- pressed "delete" on somebody, and whose deletion then never completed, saw
  -- every later action on that person fail as "the result no longer exists",
  -- which is both wrong and unactionable.
  select attestation.user_id, control.status, control.deletion_pending
  into v_user_id, v_account_status, v_account_deleting
  from public.attestations attestation
  join public.account_controls control
    on control.user_id = attestation.user_id
  where attestation.id = p_attestation_id;
  if v_user_id is null then
    raise exception using errcode = 'no_data_found',
      message = 'ATTESTATION_NOT_FOUND';
  end if;
  if v_account_deleting then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_DELETION_REQUESTED';
  end if;
  if v_account_status <> 'active' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_SUSPENDED';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attestation
  from public.attestations attestation
  where attestation.id = p_attestation_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'ATTESTATION_NOT_FOUND';
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_attestation.revision_id;
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = v_attestation.best_attempt_id;
  select * into v_localization
  from public.test_revision_localizations localization
  where localization.revision_id = v_attestation.revision_id
    and localization.locale = v_attempt.locale;
  if v_attestation.best_score < v_revision.pass_score then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTESTATION_NOT_ELIGIBLE';
  end if;
  if v_attempt.id is null or v_localization.revision_id is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CERTIFICATE_LOCALIZATION_NOT_FOUND';
  end if;

  select * into v_identity
  from public.verified_identities identity
  where identity.user_id = v_attestation.user_id
  for update;
  if v_identity.user_id is null or v_identity.status <> 'verified' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'IDENTITY_NOT_VERIFIED';
  end if;
  if exists (
    select 1
    from public.certificates certificate
    where certificate.user_id = v_attestation.user_id
      and certificate.revision_id = v_attestation.revision_id
      and certificate.revoked_at is null
  ) then
    raise exception using errcode = 'unique_violation',
      message = 'ACTIVE_CERTIFICATE_EXISTS';
  end if;

  v_certificate_id := gen_random_uuid();
  -- The year the document is dated in: a certificate issued on the night of
  -- 31 December in Oral is already the next year's, whatever UTC says.
  v_number := 'SH-' || to_char(statement_timestamp() at time zone 'Asia/Oral', 'YYYY') || '-'
    || upper(substr(replace(v_certificate_id::text, '-', ''), 1, 12));
  v_full_name := case
    when v_attempt.locale = 'zh' then
      concat_ws(' ', v_identity.surname, v_identity.name)
    else concat_ws(' ', v_identity.name, v_identity.surname)
  end;

  insert into public.certificates (
    id,
    certificate_number,
    user_id,
    revision_id,
    attestation_id,
    attempt_id,
    identity_version,
    full_name,
    job,
    organization,
    test_slug,
    test_title,
    localized_test_title,
    locale,
    score,
    total,
    pass_score,
    best_completed_at,
    issued_by,
    issue_source,
    supersedes_certificate_id
  ) values (
    v_certificate_id,
    v_number,
    v_attestation.user_id,
    v_revision.id,
    v_attestation.id,
    v_attestation.best_attempt_id,
    v_identity.version,
    v_full_name,
    v_identity.job,
    v_identity.organization,
    v_revision.slug,
    v_localization.title,
    v_localization.title,
    v_attempt.locale,
    v_attestation.best_score,
    v_revision.question_count,
    v_revision.pass_score,
    v_attestation.best_completed_at,
    p_actor_id,
    p_source,
    p_supersedes
  );

  insert into public.admin_audit_log (
    actor_user_id,
    target_user_id,
    action,
    target_type,
    target_id,
    after_data,
    batch_id
  ) values (
    p_actor_id,
    v_attestation.user_id,
    'certificate.issued',
    'certificate',
    v_certificate_id::text,
    jsonb_build_object(
      'certificateNumber', v_number,
      'source', p_source,
      'score', v_attestation.best_score,
      'revisionId', v_revision.id,
      'locale', v_attempt.locale
    ),
    p_batch_id
  );
  return v_certificate_id;
end;
$$;

revoke all on function private.issue_certificate_for_attestation(
  uuid, uuid, public.certificate_issue_source, uuid, uuid
) from public, anon, authenticated, service_role;

-- 4. The public check: the printed date, and a revoked document said so -------

create or replace function public.get_public_certificate(p_certificate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select * from public.certificates where id = p_certificate_id
  ), successor as (
    select replacement.*
    from requested
    join lateral (
      select certificate.*
      from public.certificates certificate
      where certificate.user_id = requested.user_id
        and certificate.revision_id = requested.revision_id
        and certificate.revoked_at is null
      order by certificate.issued_at desc, certificate.id desc
      limit 1
    ) replacement on true
    where requested.revoked_at is not null
  ), resolved as (
    -- A current document answers for itself; a replaced one for the document
    -- that replaced it; one withdrawn without a replacement answers as revoked.
    select requested.* from requested where requested.revoked_at is null
    union all
    select successor.* from successor
    union all
    select requested.* from requested
    where requested.revoked_at is not null
      and not exists (select 1 from successor)
  )
  select jsonb_build_object(
    'id', resolved.id,
    'certificateNumber', resolved.certificate_number,
    'fullName', resolved.full_name,
    'organization', resolved.organization,
    'testTitle', resolved.test_title,
    'score', resolved.score,
    'total', resolved.total,
    'issuedAt', resolved.issued_at,
    -- The date printed on the document: the sitting its snapshot records, or
    -- for a document older than snapshots the day of issue in Oral.
    'documentDate', coalesce(
      resolved.document_snapshot ->> 'protocolDate',
      ((resolved.issued_at at time zone 'Asia/Oral')::date)::text
    ),
    'status', case
      when resolved.revoked_at is not null
        or exists (
          select 1 from public.verified_identities identity
          where identity.user_id = resolved.user_id
            and identity.status = 'revoked'
        )
        or exists (
          select 1 from public.account_controls control
          where control.user_id = resolved.user_id
            and control.status = 'suspended'
        )
      then 'revoked'
      else 'valid'
    end
  )
  from resolved;
$$;

revoke all on function public.get_public_certificate(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_certificate(uuid) to service_role;

comment on function public.get_public_certificate(uuid) is
  'Public verification payload with the printed document date. A superseded certificate resolves to the one that replaced it; one withdrawn without a replacement, or held by a person whose identity was revoked or whose account is suspended, answers with status revoked.';

-- 7. The dashboard says which courses are open ------------------------------

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
        'courseTitle', localization.title,
        -- The test answers «not open to you» without a grant, so the row must
        -- not offer to start it.
        'accessible', private.has_course_access(v_user_id, test.id)
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

revoke all on function public.get_profile_dashboard_locale(public.app_locale)
  from public, anon, authenticated, service_role;
grant execute on function public.get_profile_dashboard_locale(public.app_locale)
  to authenticated;
