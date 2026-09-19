-- Education is required for a new printable issuance, never for completing training.
-- Preserve a legacy active document when its automatic score replacement is refused.
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
      -- The attempt and attestation above must survive a missing issuance-only field.
      -- This subtransaction restores both the old active certificate and its audit
      -- record on refusal. Every unrelated error still propagates unchanged.
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
      exception when sqlstate '22023' then
        if sqlerrm <> 'DOCUMENT_REQUIRED_FIELDS:education' then raise; end if;
      end;
    end if;
  end if;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.complete_test_attempt_unmetered(uuid,jsonb)
  from public, anon, authenticated, service_role;


-- Explicit admin issue actions can retry the improved result after the field is filled.
create or replace function private.issue_certificates_unmetered(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('certificate.issue');
  v_batch_id uuid := gen_random_uuid();
  v_attestation_id uuid;
  v_user_id uuid;
  v_certificate_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_best_score integer;
  v_items jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_attestation_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  for v_attestation_id in
    select requested.id from (select distinct unnest(p_attestation_ids) as id) requested
    left join public.attestations attestation on attestation.id = requested.id
    order by attestation.user_id nulls last, attestation.revision_id, requested.id
  loop
    begin
      -- Serialize recovery on the same user lock as completion/identity changes.
      select user_id, best_score into v_user_id, v_best_score
      from public.attestations where id=v_attestation_id;
      if v_user_id is null then
        raise exception using errcode='no_data_found',message='ATTESTATION_NOT_FOUND';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
      select best_score into v_best_score from public.attestations where id=v_attestation_id for update;
      select certificate.* into v_active_certificate
      from public.certificates certificate
      join public.attestations attestation on attestation.id=v_attestation_id
      where certificate.user_id=attestation.user_id
        and certificate.revision_id=attestation.revision_id
        and certificate.revoked_at is null
      for update of certificate;
      if found then
        if v_active_certificate.score >= v_best_score then
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'id',v_attestation_id,'status','already_completed','reason',null
          ));
          continue;
        end if;
        -- The existing per-item exception boundary restores this document on
        -- ANY failed replacement, including missing education or other fields.
        update public.certificates set revoked_at=statement_timestamp(),
          revoked_by=v_actor_id,revoke_reason='Результат улучшен'
        where id=v_active_certificate.id;
        insert into public.admin_audit_log(
          actor_user_id,target_user_id,action,target_type,target_id,after_data,reason,batch_id
        ) values(
          v_actor_id,v_user_id,'certificate.revoked','certificate',v_active_certificate.id::text,
          jsonb_build_object('certificateNumber',v_active_certificate.certificate_number),
          'Результат улучшен',v_batch_id
        );
      end if;
      v_certificate_id := private.issue_certificate_for_attestation(
        v_attestation_id, v_actor_id,
        case when v_active_certificate.id is null then 'manual'::public.certificate_issue_source
          else 'score_improvement'::public.certificate_issue_source end,
        v_active_certificate.id, v_batch_id
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'completed', 'reason', null,
        'certificateId', v_certificate_id
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

create or replace function private.confirm_and_issue_certificates_unmetered(
  p_attestation_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('certificate.issue');
  v_batch_id uuid := gen_random_uuid();
  v_attestation_id uuid;
  v_user_id uuid;
  v_certificate_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_best_score integer;
  v_items jsonb := '[]'::jsonb;
begin
  perform private.require_capability('identity.manage');
  if coalesce(cardinality(p_attestation_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  for v_attestation_id in
    select requested.id from (select distinct unnest(p_attestation_ids) as id) requested
    left join public.attestations attestation on attestation.id = requested.id
    order by attestation.user_id nulls last, attestation.revision_id, requested.id
  loop
    begin
      select attestation.user_id into v_user_id
      from public.attestations attestation
      where attestation.id = v_attestation_id;
      if v_user_id is null then
        raise exception using errcode = 'no_data_found',
          message = 'ATTESTATION_NOT_FOUND';
      end if;
      perform private.confirm_profile_identity(
        v_user_id, v_actor_id, v_batch_id, 'identity.bulk_confirm'
      );
      -- Serialize recovery on the same user lock as completion/identity changes.
      select user_id, best_score into v_user_id, v_best_score
      from public.attestations where id=v_attestation_id;
      if v_user_id is null then
        raise exception using errcode='no_data_found',message='ATTESTATION_NOT_FOUND';
      end if;
      perform pg_advisory_xact_lock(hashtextextended(v_user_id::text,0));
      select best_score into v_best_score from public.attestations where id=v_attestation_id for update;
      select certificate.* into v_active_certificate
      from public.certificates certificate
      join public.attestations attestation on attestation.id=v_attestation_id
      where certificate.user_id=attestation.user_id
        and certificate.revision_id=attestation.revision_id
        and certificate.revoked_at is null
      for update of certificate;
      if found then
        if v_active_certificate.score >= v_best_score then
          v_items := v_items || jsonb_build_array(jsonb_build_object(
            'id',v_attestation_id,'status','already_completed','reason',null
          ));
          continue;
        end if;
        -- The existing per-item exception boundary restores this document on
        -- ANY failed replacement, including missing education or other fields.
        update public.certificates set revoked_at=statement_timestamp(),
          revoked_by=v_actor_id,revoke_reason='Результат улучшен'
        where id=v_active_certificate.id;
        insert into public.admin_audit_log(
          actor_user_id,target_user_id,action,target_type,target_id,after_data,reason,batch_id
        ) values(
          v_actor_id,v_user_id,'certificate.revoked','certificate',v_active_certificate.id::text,
          jsonb_build_object('certificateNumber',v_active_certificate.certificate_number),
          'Результат улучшен',v_batch_id
        );
      end if;
      v_certificate_id := private.issue_certificate_for_attestation(
        v_attestation_id, v_actor_id,
        case when v_active_certificate.id is null then 'manual'::public.certificate_issue_source
          else 'score_improvement'::public.certificate_issue_source end,
        v_active_certificate.id, v_batch_id
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'completed', 'reason', null,
        'certificateId', v_certificate_id
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

revoke all on function private.confirm_and_issue_certificates_unmetered(uuid[])
  from public, anon, authenticated, service_role;


revoke all on function private.issue_certificates_unmetered(uuid[])
  from public,anon,authenticated,service_role;

-- Improved results remain issued/exportable while appearing as actionable for reissue.
create or replace function public.resolve_admin_attestation_selection(
  p_query text default null,
  p_organization text default null,
  p_test_id uuid default null,
  p_result_state text default null,
  p_certificate_state text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_sort text default 'completed_desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_organization text := nullif(private.normalized_lookup_key(p_organization), '');
  v_count integer;
  v_result jsonb;
begin
  perform private.require_capability('results.read');
  with filtered as (
    select row.* from private.admin_attestation_rows row
    where (v_query is null
        or private.normalized_lookup_key(row.full_name) like '%' || v_query || '%'
        or row.organization_key like '%' || v_query || '%'
        or private.normalized_lookup_key(row.course_title) like '%' || v_query || '%'
        or private.normalized_lookup_key(row.certificate_number) = v_query)
      and (v_organization is null or row.organization_key = v_organization)
      and (p_test_id is null or row.test_id = p_test_id)
      and (p_result_state is null
        or (p_result_state = 'passed' and row.score >= row.pass_score)
        or (p_result_state = 'failed' and row.score < row.pass_score))
      and (p_certificate_state is null or row.certificate_state = p_certificate_state)
      and (p_from is null or row.completed_at >= p_from)
      and (p_to is null or row.completed_at < p_to)
  )
  select count(*)::integer into v_count from filtered;
  if v_count > 500 then
    raise exception using errcode = 'program_limit_exceeded', message = 'ATTESTATION_SELECTION_TOO_LARGE';
  end if;

  with filtered as (
    select row.* from private.admin_attestation_rows row
    where (v_query is null
        or private.normalized_lookup_key(row.full_name) like '%' || v_query || '%'
        or row.organization_key like '%' || v_query || '%'
        or private.normalized_lookup_key(row.course_title) like '%' || v_query || '%'
        or private.normalized_lookup_key(row.certificate_number) = v_query)
      and (v_organization is null or row.organization_key = v_organization)
      and (p_test_id is null or row.test_id = p_test_id)
      and (p_result_state is null
        or (p_result_state = 'passed' and row.score >= row.pass_score)
        or (p_result_state = 'failed' and row.score < row.pass_score))
      and (p_certificate_state is null or row.certificate_state = p_certificate_state)
      and (p_from is null or row.completed_at >= p_from)
      and (p_to is null or row.completed_at < p_to)
  )
  select jsonb_build_object(
    'recordIds', coalesce(jsonb_agg(attestation_id order by attestation_id), '[]'::jsonb),
    'attestationIds', coalesce(jsonb_agg(attestation_id order by attestation_id)
      filter (where test_id is not null), '[]'::jsonb),
    'userIds', coalesce(jsonb_agg(distinct user_id)
      filter (where test_id is not null), '[]'::jsonb),
    'certificateIds', coalesce(jsonb_agg(distinct certificate_id)
      filter (where certificate_id is not null and certificate_state = 'issued'), '[]'::jsonb),
    'total', v_count,
    'uniquePeople', count(distinct user_id) filter (where test_id is not null),
    'pendingIdentity', count(*) filter (
      where test_id is not null and certificate_state = 'pending_identity'
    ),
    'ready', count(*) filter (
      where test_id is not null and (certificate_state in ('ready', 'revoked') or (certificate_state='issued' and identity_state='verified' and score_improved))
    ),
    'issued', count(*) filter (where certificate_state = 'issued'),
    'exportable', count(*) filter (where certificate_state = 'issued')
  ) into v_result from filtered;
  return v_result;
end;
$$;

create or replace function public.get_admin_work_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The application reads the counters through the service role from a short
  -- server cache and checks the capability itself; a signed-in operator can
  -- still call the function directly under the same capability as before.
  if coalesce((select auth.role()), '') <> 'service_role' then
    perform private.require_capability('results.read');
  end if;
  return jsonb_build_object(
    'pendingIdentity', (
      select count(distinct row.user_id)
      from private.admin_attestation_rows row
      where row.test_id is not null and row.identity_state <> 'verified'
    ),
    'readyToIssue', (
      select count(*)
      from private.admin_attestation_rows row
      where row.test_id is not null and (row.certificate_state in ('ready', 'revoked') or (row.certificate_state='issued' and row.identity_state='verified' and row.score_improved))
    ),
    'companyIssues', (
      select count(*)
      from public.profiles profile
      where profile.organization <> '' and profile.organization_id is null
    ),
    'activeCertificates', (
      select count(*) from public.certificates certificate where certificate.revoked_at is null
    ),
    'generatedAt', statement_timestamp()
  );
end;
$$;

revoke execute on function public.get_admin_work_queue() from public, anon;
grant execute on function public.get_admin_work_queue() to authenticated, service_role;


-- Preserve only the exact new safe education refusal through the existing envelopes.
create or replace function private.rpc_error_envelope(
  p_sqlstate text,
  p_message text,
  p_detail text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text := case
    when coalesce(p_sqlstate, '') ~ '^[0-9A-Z]{5}$' then p_sqlstate
    else 'P0001'
  end;
  v_message text;
  v_detail jsonb;
  v_retry_at_text text;
  v_retry_at timestamptz;
begin
  if coalesce(p_message, '') ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$'
    or (v_state='22023' and p_message='DOCUMENT_REQUIRED_FIELDS:education') then
    v_message := p_message;
  else
    v_message := case
      when v_state = '42501' then 'FORBIDDEN'
      when v_state = '23505' then 'CONFLICT'
      when v_state in ('23502', '23503', '23514', '23P01') then 'CONSTRAINT_VIOLATION'
      when v_state in ('22003', '22007', '22023') then 'INVALID_REQUEST'
      when v_state = 'P0002' then 'NOT_FOUND'
      when v_state = '55000' then 'INVALID_STATE'
      when v_state in ('40001', '40P01') then 'RETRYABLE_TRANSACTION_ERROR'
      else 'RPC_MUTATION_FAILED'
    end;
  end if;

  -- ATTEMPT_DAILY_LIMIT is the v3 product contract. Keep the former rolling
  -- code parse-only while old application instances can still finish a
  -- rolling deployment; no v3 admission path emits it.
  if v_state = '54000'
    and v_message in ('ATTEMPT_ROLLING_LIMIT', 'ATTEMPT_DAILY_LIMIT')
    and p_detail is not null
    and octet_length(p_detail) between 20 and 96 then
    begin
      v_detail := p_detail::jsonb;
      if jsonb_typeof(v_detail) = 'object'
        and (select count(*) from jsonb_object_keys(v_detail)) = 1
        and v_detail ? 'retryAt'
        and jsonb_typeof(v_detail -> 'retryAt') = 'string' then
        v_retry_at_text := v_detail ->> 'retryAt';
        if char_length(v_retry_at_text) between 20 and 40
          and v_retry_at_text ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$' then
          v_retry_at := v_retry_at_text::timestamptz;
          if v_retry_at is not null then
            v_detail := jsonb_build_object(
              'retryAt',
              to_char(v_retry_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            );
          else
            v_detail := null;
          end if;
        else
          v_detail := null;
        end if;
      else
        v_detail := null;
      end if;
    exception when others then
      v_detail := null;
    end;
  end if;

  return jsonb_build_object(
    '__safetyhubRpcError',
    jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'code', v_state,
      'message', v_message,
      'details', v_detail
    ))
  );
end;
$$;

create or replace function private.sanitize_bulk_mutation_result(p_payload jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_payload) <> 'array' then p_payload
    else coalesce((
      select jsonb_agg(
        case
          when jsonb_typeof(item.value) = 'object'
            and item.value ->> 'status' = 'skipped'
            and item.value ? 'reason'
          then jsonb_set(
            item.value,
            '{reason}',
            to_jsonb(case
              when coalesce(item.value ->> 'reason', '')
                ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$'
                or item.value->>'reason'='DOCUMENT_REQUIRED_FIELDS:education'
              then item.value ->> 'reason'
              else 'OPERATION_SKIPPED'
            end),
            false
          )
          else item.value
        end
        order by item.ordinality
      )
      from jsonb_array_elements(p_payload) with ordinality as item(value, ordinality)
    ), '[]'::jsonb)
  end;
$$;
