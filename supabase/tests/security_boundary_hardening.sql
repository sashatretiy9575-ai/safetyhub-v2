begin;

do $test$
declare
  v_challenge_hash text := repeat('a', 64);
  v_email_hash text := repeat('b', 64);
  v_other_email_hash text := repeat('c', 64);
  v_expired_hash text := repeat('d', 64);
  v_pruned_hash text := repeat('e', 64);
  v_result jsonb;
  v_attempt integer;
  v_denied boolean := false;
  v_actor_id uuid;
  v_actor_ids uuid[] := '{}'::uuid[];
  v_actor_index integer;
  v_lease_one uuid;
  v_lease_two uuid;
  v_filler_lease uuid;
begin
  if has_table_privilege('anon', 'private.email_otp_challenges', 'select')
    or has_table_privilege('authenticated', 'private.email_otp_challenges', 'select')
    or has_table_privilege('service_role', 'private.email_otp_challenges', 'select')
    or has_table_privilege('anon', 'private.course_presentation_download_leases', 'select')
    or has_table_privilege('authenticated', 'private.course_presentation_download_leases', 'select')
    or has_table_privilege('service_role', 'private.course_presentation_download_leases', 'select') then
    raise exception 'private security-boundary tables expose a direct read grant';
  end if;

  if exists (
    select 1
    from information_schema.columns column_info
    where column_info.table_schema = 'private'
      and column_info.table_name = 'email_otp_challenges'
      and column_info.column_name in ('email', 'normalized_email', 'token', 'challenge_token')
  ) then
    raise exception 'email OTP challenge table stores raw token or email PII';
  end if;

  if has_function_privilege(
      'anon', 'public.issue_email_otp_challenge(text,text,integer)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.issue_email_otp_challenge(text,text,integer)', 'execute'
    )
    or has_function_privilege(
      'anon', 'public.consume_email_otp_challenge_attempt(text,text)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.consume_email_otp_challenge_attempt(text,text)', 'execute'
    )
    or has_function_privilege(
      'anon', 'public.complete_email_otp_challenge(text,text)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.complete_email_otp_challenge(text,text)', 'execute'
    )
    or has_function_privilege(
      'anon', 'public.prune_email_otp_challenges(integer)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.prune_email_otp_challenges(integer)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.issue_email_otp_challenge(text,text,integer)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.consume_email_otp_challenge_attempt(text,text)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.complete_email_otp_challenge(text,text)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.prune_email_otp_challenges(integer)', 'execute'
    ) then
    raise exception 'email OTP challenge RPC grants are not service-role-only';
  end if;

  perform set_config('request.jwt.claim.role', 'anon', true);
  begin
    perform public.issue_email_otp_challenge(v_challenge_hash, v_email_hash, 3600);
  exception when insufficient_privilege then
    if sqlerrm = 'SERVICE_ROLE_REQUIRED' then
      v_denied := true;
    else
      raise;
    end if;
  end;
  if not v_denied then
    raise exception 'anon claim bypassed email OTP challenge role check';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.issue_email_otp_challenge(v_challenge_hash, v_email_hash, 3600);
  if coalesce((v_result ->> 'issued')::boolean, false) is not true then
    raise exception 'email OTP challenge was not issued';
  end if;

  v_result := public.consume_email_otp_challenge_attempt(
    v_challenge_hash, v_other_email_hash
  );
  if v_result ->> 'reason' is distinct from 'invalid'
    or (select attempt_count from private.email_otp_challenges
        where challenge_hash = v_challenge_hash) is distinct from 0 then
    raise exception 'wrong email binding was distinguishable or consumed an attempt';
  end if;

  for v_attempt in 1..6 loop
    v_result := public.consume_email_otp_challenge_attempt(
      v_challenge_hash, v_email_hash
    );
    if coalesce((v_result ->> 'allowed')::boolean, false) is not true
      or (v_result ->> 'attemptsRemaining')::integer is distinct from 6 - v_attempt then
      raise exception 'challenge-bound OTP attempt % was not consumed atomically', v_attempt;
    end if;
  end loop;
  v_result := public.consume_email_otp_challenge_attempt(
    v_challenge_hash, v_email_hash
  );
  if coalesce((v_result ->> 'allowed')::boolean, true) is not false
    or v_result ->> 'reason' is distinct from 'exhausted'
    or (v_result ->> 'retryAfter')::integer < 1 then
    raise exception 'seventh OTP attempt did not return stable challenge exhaustion';
  end if;
  if public.complete_email_otp_challenge(v_challenge_hash, v_email_hash) is not true
    or public.complete_email_otp_challenge(v_challenge_hash, v_email_hash) is not false then
    raise exception 'email OTP completion was not single-use';
  end if;

  perform public.issue_email_otp_challenge(v_expired_hash, v_email_hash, 3600);
  update private.email_otp_challenges
  set issued_at = statement_timestamp() - interval '2 hours',
      expires_at = statement_timestamp() - interval '1 hour'
  where challenge_hash = v_expired_hash;
  v_result := public.consume_email_otp_challenge_attempt(v_expired_hash, v_email_hash);
  if v_result ->> 'reason' is distinct from 'invalid'
    or exists (select 1 from private.email_otp_challenges where challenge_hash = v_expired_hash) then
    raise exception 'expired email OTP challenge remained usable or durable';
  end if;

  perform public.issue_email_otp_challenge(v_pruned_hash, v_email_hash, 3600);
  update private.email_otp_challenges
  set issued_at = statement_timestamp() - interval '2 hours',
      expires_at = statement_timestamp() - interval '1 hour'
  where challenge_hash = v_pruned_hash;
  v_result := public.prune_email_otp_challenges(1);
  if (v_result ->> 'deleted')::integer is distinct from 1
    or exists (select 1 from private.email_otp_challenges where challenge_hash = v_pruned_hash) then
    raise exception 'bounded email OTP challenge pruning failed';
  end if;

  v_denied := false;
  begin
    perform public.issue_email_otp_challenge(repeat('f', 64), v_email_hash, 3601);
  exception when invalid_parameter_value then
    if sqlerrm = 'OTP_CHALLENGE_INVALID' then
      v_denied := true;
    else
      raise;
    end if;
  end;
  if not v_denied then
    raise exception 'email OTP challenge exceeded the one-hour lifetime';
  end if;

  if has_function_privilege(
      'anon', 'public.claim_course_presentation_download_lease(uuid,integer)', 'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.claim_course_presentation_download_lease(uuid,integer)',
      'execute'
    )
    or has_function_privilege(
      'anon', 'public.release_course_presentation_download_lease(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.release_course_presentation_download_lease(uuid,uuid)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.claim_course_presentation_download_lease(uuid,integer)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.release_course_presentation_download_lease(uuid,uuid)', 'execute'
    ) then
    raise exception 'presentation lease RPC grants are not service-role-only';
  end if;

  select actual.quota, actual.window_seconds
  into strict v_attempt, v_actor_index
  from private.quota_policy('presentation.download') actual;
  if (v_attempt, v_actor_index) is distinct from (12, 300) then
    raise exception 'presentation.download quota policy is not 12 per 300 seconds';
  end if;

  for v_actor_index in 1..13 loop
    v_actor_id := extensions.gen_random_uuid();
    v_actor_ids := array_append(v_actor_ids, v_actor_id);
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
      created_at, updated_at
    ) values (
      '00000000-0000-0000-0000-000000000000', v_actor_id,
      'authenticated', 'authenticated',
      format('presentation-lease-%s@safetyhub.invalid', v_actor_index), '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );
  end loop;

  v_result := public.claim_course_presentation_download_lease(v_actor_ids[1], 90);
  v_lease_one := (v_result ->> 'leaseId')::uuid;
  v_result := public.claim_course_presentation_download_lease(v_actor_ids[1], 90);
  v_lease_two := (v_result ->> 'leaseId')::uuid;
  v_result := public.claim_course_presentation_download_lease(v_actor_ids[1], 90);
  if coalesce((v_result ->> 'allowed')::boolean, true) is not false
    or (v_result ->> 'retryAfter')::integer < 1 then
    raise exception 'per-actor presentation lease ceiling exceeded two';
  end if;

  for v_actor_index in 2..11 loop
    v_result := public.claim_course_presentation_download_lease(
      v_actor_ids[v_actor_index], 90
    );
    if coalesce((v_result ->> 'allowed')::boolean, false) is not true then
      raise exception 'presentation lease global fixture failed at actor %', v_actor_index;
    end if;
    v_filler_lease := (v_result ->> 'leaseId')::uuid;
  end loop;
  v_result := public.claim_course_presentation_download_lease(v_actor_ids[12], 90);
  if coalesce((v_result ->> 'allowed')::boolean, true) is not false
    or (v_result ->> 'retryAfter')::integer < 1 then
    raise exception 'global presentation lease ceiling exceeded twelve';
  end if;

  if public.release_course_presentation_download_lease(
      v_lease_one, v_actor_ids[2]
    ) is not false
    or public.release_course_presentation_download_lease(
      v_lease_one, v_actor_ids[1]
    ) is not true then
    raise exception 'presentation lease release was not bound to its actor';
  end if;
  v_result := public.claim_course_presentation_download_lease(v_actor_ids[12], 90);
  if coalesce((v_result ->> 'allowed')::boolean, false) is not true then
    raise exception 'released global presentation capacity was not reusable';
  end if;

  update private.course_presentation_download_leases
  set claimed_at = statement_timestamp() - interval '2 minutes',
      expires_at = statement_timestamp() - interval '1 minute'
  where id = v_lease_two;
  v_result := public.claim_course_presentation_download_lease(v_actor_ids[13], 90);
  if coalesce((v_result ->> 'allowed')::boolean, false) is not true
    or exists (
      select 1 from private.course_presentation_download_leases where id = v_lease_two
    ) then
    raise exception 'expired presentation lease did not recover capacity atomically';
  end if;
end;
$test$;

rollback;
