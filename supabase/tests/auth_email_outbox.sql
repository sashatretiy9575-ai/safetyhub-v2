begin;

-- Durable sign-in email queue and the one-call OTP gateway introduced by
-- 20260912182000_auth_email_outbox_and_otp_gateway.sql.
do $test$
declare
  v_first jsonb;
  v_second jsonb;
  v_id uuid;
  v_claimed jsonb;
  v_lease uuid;
  v_result jsonb;
  v_status text;
  v_token text;
  v_attempts integer;
  v_schedule text;
  v_command text;
  v_ip_hash text := repeat('a', 64);
  v_email_hash text := repeat('b', 64);
  v_challenge_hash text := repeat('c', 64);
  v_gate jsonb;
  v_index integer;
begin
  -- Grants: the queue and the gateway are service-role only; the table is
  -- reachable through the RPCs alone.
  if has_table_privilege('service_role', 'private.auth_email_outbox', 'SELECT')
    or has_table_privilege('authenticated', 'private.auth_email_outbox', 'SELECT')
    or has_table_privilege('anon', 'private.auth_email_outbox', 'SELECT') then
    raise exception 'auth_email_outbox must not be readable directly';
  end if;
  for v_command in
    select unnest(array[
      'public.enqueue_auth_email(text, text, text, text, text)',
      'public.claim_auth_email_outbox(uuid, integer, integer, uuid)',
      'public.complete_auth_email(uuid, uuid)',
      'public.fail_auth_email(uuid, uuid, text, integer)',
      'public.defer_auth_email(uuid, uuid, integer)',
      'public.prune_auth_email_outbox(integer)',
      'public.auth_email_outbox_summary()',
      'public.configure_auth_email_drain_vault(text, text)',
      'public.begin_email_otp_request(text, text, text)',
      'public.begin_email_otp_verify(text, text, text)'
    ])
  loop
    if has_function_privilege('anon', v_command, 'execute')
      or has_function_privilege('authenticated', v_command, 'execute')
      or not has_function_privilege('service_role', v_command, 'execute') then
      raise exception 'grants on % are unsafe', v_command;
    end if;
  end loop;
  if has_function_privilege('service_role', 'private.request_auth_email_drain()', 'execute') then
    raise exception 'the drain trigger must stay internal to pg_cron';
  end if;

  -- A signed-in operator cannot enqueue or drain.
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.enqueue_auth_email('wh_1', 'person@example.com', 'ru', 'magiclink', '123456');
    raise exception 'enqueue is callable by authenticated callers';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Enqueue dedupes on the webhook id; the recipient is normalized.
  v_first := public.enqueue_auth_email('wh_test_1', ' Person@Example.COM ', 'kk', 'magiclink', '123456');
  v_second := public.enqueue_auth_email('wh_test_1', 'person@example.com', 'kk', 'magiclink', '123456');
  if (v_first ->> 'duplicate') <> 'false' or (v_second ->> 'duplicate') <> 'true'
    or (v_first ->> 'id') <> (v_second ->> 'id') then
    raise exception 'webhook replay must be reported as a duplicate of the same row';
  end if;
  v_id := (v_first ->> 'id')::uuid;
  select outbox.recipient into v_command from private.auth_email_outbox outbox where outbox.id = v_id;
  if v_command <> 'person@example.com' then
    raise exception 'recipient must be lower-cased and trimmed, got %', v_command;
  end if;

  -- Claim leases the row, complete erases the code.
  v_claimed := public.claim_auth_email_outbox(gen_random_uuid(), 10, 60, v_id);
  if jsonb_array_length(v_claimed) <> 1
    or not (v_claimed -> 0 ?& array['id', 'recipient', 'locale', 'kind', 'token', 'attempts', 'leaseToken']) then
    raise exception 'claim must return the leased row with its lease token';
  end if;
  v_lease := (v_claimed -> 0 ->> 'leaseToken')::uuid;
  if jsonb_array_length(public.claim_auth_email_outbox(gen_random_uuid(), 10, 60, null)) <> 0 then
    raise exception 'a leased row must not be claimed twice';
  end if;
  if public.complete_auth_email(v_id, gen_random_uuid()) then
    raise exception 'complete must require the matching lease token';
  end if;
  if not public.complete_auth_email(v_id, v_lease) then
    raise exception 'complete with the lease token must succeed';
  end if;
  select outbox.status, outbox.token into v_status, v_token
  from private.auth_email_outbox outbox where outbox.id = v_id;
  if v_status <> 'sent' or v_token is not null then
    raise exception 'a sent row must have status sent and no code, got % / %', v_status, v_token;
  end if;

  -- Failure backs off and keeps the attempt; deferral gives the attempt back.
  v_first := public.enqueue_auth_email('wh_test_2', 'second@example.com', 'en', 'signup', '654321');
  v_id := (v_first ->> 'id')::uuid;
  v_claimed := public.claim_auth_email_outbox(gen_random_uuid(), 10, 60, v_id);
  v_lease := (v_claimed -> 0 ->> 'leaseToken')::uuid;
  v_result := public.fail_auth_email(v_id, v_lease, 'SMTP_TIMEOUT', 45);
  if (v_result ->> 'status') <> 'queued' or (v_result ->> 'retryAfter')::integer <> 45 then
    raise exception 'first failure must requeue with the requested backoff, got %', v_result;
  end if;
  select outbox.attempts, outbox.last_error into v_attempts, v_command
  from private.auth_email_outbox outbox where outbox.id = v_id;
  if v_attempts <> 1 or v_command <> 'SMTP_TIMEOUT' then
    raise exception 'failure must keep the attempt and record the stage';
  end if;
  update private.auth_email_outbox set next_attempt_at = statement_timestamp() where id = v_id;
  v_claimed := public.claim_auth_email_outbox(gen_random_uuid(), 10, 60, v_id);
  v_lease := (v_claimed -> 0 ->> 'leaseToken')::uuid;
  if not public.defer_auth_email(v_id, v_lease, 600) then
    raise exception 'deferral with the lease token must succeed';
  end if;
  select outbox.attempts, outbox.status, outbox.last_error into v_attempts, v_status, v_command
  from private.auth_email_outbox outbox where outbox.id = v_id;
  if v_attempts <> 1 or v_status <> 'queued' or v_command <> 'MAILBOX_THROTTLED' then
    raise exception 'deferral must give the attempt back, got % % %', v_attempts, v_status, v_command;
  end if;

  -- After the fifth claim a failure is final and the code is erased.
  update private.auth_email_outbox set attempts = 4, next_attempt_at = statement_timestamp() where id = v_id;
  v_claimed := public.claim_auth_email_outbox(gen_random_uuid(), 10, 60, v_id);
  v_lease := (v_claimed -> 0 ->> 'leaseToken')::uuid;
  v_result := public.fail_auth_email(v_id, v_lease, 'SMTP_RCPT', 120);
  if (v_result ->> 'status') <> 'failed' then
    raise exception 'the fifth failure must be final, got %', v_result;
  end if;
  select outbox.token into v_token from private.auth_email_outbox outbox where outbox.id = v_id;
  if v_token is not null then
    raise exception 'a dead row must not keep the code';
  end if;

  -- Summary and retention.
  v_result := public.auth_email_outbox_summary();
  if not (v_result ?& array['queued', 'sending', 'failedLastDay', 'sentLastHour']) then
    raise exception 'summary keys are wrong: %', v_result;
  end if;
  if public.prune_auth_email_outbox(500) <> 0 then
    raise exception 'fresh rows must survive pruning';
  end if;
  update private.auth_email_outbox set created_at = statement_timestamp() - interval '8 days';
  if public.prune_auth_email_outbox(500) <> 2 then
    raise exception 'sent and failed rows older than a week must be pruned';
  end if;

  -- Schedules: the drain runs only when something is due, the prune is daily.
  select job.schedule, job.command into v_schedule, v_command
  from cron.job job where job.jobname = 'safetyhub-auth-email-drain';
  if v_schedule is distinct from '*/2 * * * *' or v_command !~ 'exists' or v_command !~ 'lease_until' then
    raise exception 'auth email drain schedule is wrong: % / %', v_schedule, v_command;
  end if;
  select job.schedule into v_schedule
  from cron.job job where job.jobname = 'safetyhub-auth-email-prune';
  if v_schedule is distinct from '45 4 * * *' then
    raise exception 'auth email prune schedule is %, expected 45 4 * * *', v_schedule;
  end if;
  if private.request_auth_email_drain() is not null then
    raise exception 'the drain request must be dormant without Vault configuration';
  end if;
  begin
    perform public.configure_auth_email_drain_vault('http://safetyhub.kz/api/auth/send-email/drain', repeat('s', 40));
    raise exception 'a plain-http drain URL must be refused';
  exception when check_violation then
    null;
  end;

  -- OTP gateway: quota, then the address cooldown, then the sweep.
  v_gate := public.begin_email_otp_request(v_ip_hash, 'gate@example.com', v_email_hash);
  if (v_gate ->> 'allowed') <> 'true' or v_gate ? 'reason' then
    raise exception 'a fresh address must be allowed, got %', v_gate;
  end if;
  perform public.issue_email_otp_challenge(v_challenge_hash, v_email_hash, 3600);
  v_gate := public.begin_email_otp_request(v_ip_hash, 'gate@example.com', v_email_hash);
  if (v_gate ->> 'allowed') <> 'false' or (v_gate ->> 'reason') <> 'address_cooldown'
    or (v_gate ->> 'retryAfter')::integer not between 1 and 60 then
    raise exception 'a code sent under a minute ago must answer address_cooldown, got %', v_gate;
  end if;
  -- The cooldown never blocks another address, and the network budget is
  -- the same 60 requests per 15 minutes as before the merge.
  for v_index in 1..58 loop
    v_gate := public.begin_email_otp_request(v_ip_hash, 'other@example.com', repeat('d', 64));
    if (v_gate ->> 'allowed') <> 'true' then
      raise exception 'request % must still be inside the network quota, got %', v_index, v_gate;
    end if;
  end loop;
  v_gate := public.begin_email_otp_request(v_ip_hash, 'other@example.com', repeat('d', 64));
  if (v_gate ->> 'allowed') <> 'false' or (v_gate ->> 'reason') <> 'rate_limited'
    or (v_gate ->> 'retryAfter')::integer < 1 then
    raise exception 'the 61st request must be rate limited, got %', v_gate;
  end if;

  v_gate := public.begin_email_otp_verify(v_ip_hash, v_challenge_hash, v_email_hash);
  if (v_gate ->> 'allowed') <> 'true' or (v_gate ->> 'attemptsRemaining')::integer <> 5 then
    raise exception 'verify must consume one attempt of the issued challenge, got %', v_gate;
  end if;
  v_gate := public.begin_email_otp_verify(v_ip_hash, repeat('e', 64), v_email_hash);
  if (v_gate ->> 'allowed') <> 'false' or (v_gate ->> 'reason') <> 'invalid' then
    raise exception 'an unknown challenge must be invalid, got %', v_gate;
  end if;
  begin
    perform public.begin_email_otp_request(v_ip_hash, 'gate@example.com', 'not-a-hash');
    raise exception 'a malformed email hash must be refused';
  exception when invalid_parameter_value then
    null;
  end;
end;
$test$;

rollback;
