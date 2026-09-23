-- A learner who beats the score on an active certificate gets the certificate
-- reissued inside the submission. Only a missing education was allowed to
-- refuse that reissue; any other refusal rolled the submission back, so the
-- better result was never recorded and the attempt eventually expired. Now
-- every refusal keeps the earlier certificate and the result stands.
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
        -- A transaction the server must retry is still retried.
        when serialization_failure or deadlock_detected then raise;
        -- Any refusal to issue the better document — a missing field, a
        -- recorded failed exam, a signature out of step, a full journal —
        -- leaves the earlier certificate standing. It used to roll back the
        -- whole submission: the learner's answers, score and pass were lost
        -- and every retry failed the same way until the attempt expired.
        when others then null;
      end;
    end if;
  end if;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.complete_test_attempt_unmetered(uuid,jsonb)
  from public, anon, authenticated, service_role;
