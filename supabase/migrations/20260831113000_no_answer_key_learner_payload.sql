-- Assessment answer keys must never leave private tables through a learner
-- payload. The prior implementation exposed correctOptionId in the passed
-- attempt review, which let a browser reconstruct the answer key. Keep only
-- the score/result summary; the learner can revisit the approved course
-- material, but never receives per-question answer-key data from an RPC.

create or replace function private.attempt_payload(
  p_attempt_id uuid,
  p_retry_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_certificate public.certificates%rowtype;
  v_questions jsonb := '[]'::jsonb;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;

  select * into v_revision from public.test_revisions where id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id and variant.revision_id = v_attempt.revision_id;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  select * into v_certificate
  from public.certificates certificate
  where certificate.user_id = v_attempt.user_id
    and certificate.revision_id = v_attempt.revision_id
    and certificate.revoked_at is null
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', question.value ->> 'id',
    'text', question.value ->> 'text',
    'position', question.ordinality,
    'selectedOptionId', case
      when v_attempt.status = 'started' and v_attempt.answers is not null
        then question.value -> 'options'
          -> v_attempt.answers[question.ordinality::integer] ->> 'id'
      else null
    end,
    'options', question.value -> 'options'
  ) order by question.ordinality), '[]'::jsonb)
  into v_questions
  from jsonb_array_elements(v_variant.questions)
    with ordinality question(value, ordinality);

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'courseId', v_attempt.test_id,
    'revisionId', v_attempt.revision_id,
    'testSlug', v_revision.slug,
    'title', v_revision.title,
    'status', v_attempt.status,
    'score', v_attempt.score,
    'total', v_variant.question_count,
    'passScore', v_attempt.pass_score,
    'passed', case
      when v_attempt.status = 'passed' then true
      when v_attempt.status = 'failed' then false
      else null
    end,
    'certificateId', v_certificate.id,
    'certificatePendingVerification',
      v_attempt.status = 'passed'
      and v_certificate.id is null
      and private.identity_state(v_attempt.user_id) <> 'verified',
    'durationMinutes', v_attempt.duration_minutes,
    'startedAt', v_attempt.started_at,
    'expiresAt', v_attempt.expires_at,
    'serverNow', statement_timestamp(),
    'retryAt', p_retry_at,
    'questions', v_questions
  );
end;
$$;

comment on function private.attempt_payload(uuid,timestamptz) is
  'Learner attempt payload with questions/options and result summary only. It intentionally contains no answer key, correct option, per-question correctness, explanation, variant identity, or unpublished metadata.';
