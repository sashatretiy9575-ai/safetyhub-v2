begin;

do $test$
declare
  v_actor_id uuid := '71000000-0000-4000-8000-000000000001';
  v_queue_user_a uuid := '71000000-0000-4000-8000-000000000002';
  v_queue_user_b uuid := '71000000-0000-4000-8000-000000000003';
  v_queue_user_c uuid := '71000000-0000-4000-8000-000000000004';
  v_queue_user_d uuid := '71000000-0000-4000-8000-000000000005';
  v_decision_target_id uuid := '71000000-0000-4000-8000-000000000006';
  v_expired_key uuid := '72000000-0000-4000-8000-000000000001';
  v_other_expired_key uuid := '72000000-0000-4000-8000-000000000002';
  v_requested_at timestamptz := timestamptz '1900-01-01 00:00:00+00';
  v_due_at timestamptz := timestamptz '1900-01-02 00:00:00+00';
  v_first_page jsonb;
  v_second_page jsonb;
  v_first_cursor_due_at timestamptz;
  v_first_cursor_user_id uuid;
  v_decision jsonb;
  v_replay jsonb;
  v_receipt private.account_approval_decision_receipts%rowtype;
  v_submission_definition text;
  v_control_lock_offset integer;
  v_profile_lock_offset integer;
begin
  -- These rows are deliberately earlier than any ordinary fixture. Four
  -- pending learners with a page size of two prove that the look-ahead third
  -- row appears on page two rather than being skipped by the cursor.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_actor_id,
      'authenticated', 'authenticated', 'approval-queue-actor@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_queue_user_a,
      'authenticated', 'authenticated', 'approval-queue-a@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_queue_user_b,
      'authenticated', 'authenticated', 'approval-queue-b@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_queue_user_c,
      'authenticated', 'authenticated', 'approval-queue-c@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_queue_user_d,
      'authenticated', 'authenticated', 'approval-queue-d@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_decision_target_id,
      'authenticated', 'authenticated', 'approval-decision-target@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  update public.user_roles
  set role = 'admin'
  where user_id = v_actor_id;

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at,
      approval_due_at = v_due_at,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id in (
    v_queue_user_a,
    v_queue_user_b,
    v_queue_user_c,
    v_queue_user_d
  );

  update public.account_controls
  set approval_state = 'pending',
      approval_requested_at = v_requested_at + interval '1 hour',
      approval_due_at = v_due_at + interval '1 hour',
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_decision_target_id;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor_id::text, true);

  v_first_page := public.list_pending_account_approval_page(2, null, null);
  if jsonb_array_length(v_first_page -> 'items') <> 2
    or (v_first_page -> 'items' -> 0 ->> 'id')::uuid is distinct from v_queue_user_a
    or (v_first_page -> 'items' -> 1 ->> 'id')::uuid is distinct from v_queue_user_b
    or (v_first_page ->> 'hasMore')::boolean is not true
    or (v_first_page ->> 'total')::integer < 4 then
    raise exception 'approval queue first page/cursor fixture invalid: %', v_first_page;
  end if;

  v_first_cursor_due_at := (v_first_page -> 'nextCursor' ->> 'at')::timestamptz;
  v_first_cursor_user_id := (v_first_page -> 'nextCursor' ->> 'id')::uuid;
  if v_first_cursor_due_at is distinct from v_due_at
    or v_first_cursor_user_id is distinct from v_queue_user_b then
    raise exception 'approval queue cursor did not identify final visible row: %',
      v_first_page;
  end if;

  v_second_page := public.list_pending_account_approval_page(
    2,
    v_first_cursor_due_at,
    v_first_cursor_user_id
  );
  if jsonb_array_length(v_second_page -> 'items') <> 2
    or (v_second_page -> 'items' -> 0 ->> 'id')::uuid is distinct from v_queue_user_c
    or (v_second_page -> 'items' -> 1 ->> 'id')::uuid is distinct from v_queue_user_d then
    raise exception 'approval queue skipped look-ahead row on second page: first %, second %',
      v_first_page, v_second_page;
  end if;

  -- Do not call the scheduled pruning RPC. The decision must retire only the
  -- expired receipt for this exact actor/key synchronously before it decides
  -- whether a live receipt can be replayed.
  insert into private.account_approval_decision_receipts (
    actor_user_id, idempotency_key, request_hash, result, created_at, expires_at
  ) values
    (
      v_actor_id, v_expired_key, repeat('0', 64),
      jsonb_build_object('approvalState', 'rejected', 'replayed', false),
      statement_timestamp() - interval '2 days',
      statement_timestamp() - interval '1 day'
    ),
    (
      v_actor_id, v_other_expired_key, repeat('1', 64),
      jsonb_build_object('approvalState', 'rejected', 'replayed', false),
      statement_timestamp() - interval '2 days',
      statement_timestamp() - interval '1 day'
    );

  v_decision := public.decide_account_approval(
    v_expired_key,
    v_decision_target_id,
    'approved',
    null
  );
  if (v_decision ->> 'approvalState') is distinct from 'approved'
    or (v_decision ->> 'replayed')::boolean is not false then
    raise exception 'expired decision receipt was replayed instead of replaced: %', v_decision;
  end if;

  select * into v_receipt
  from private.account_approval_decision_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = v_expired_key;
  if not found
    or v_receipt.request_hash = repeat('0', 64)
    or v_receipt.expires_at <= statement_timestamp()
    or (select count(*)
        from private.account_approval_decision_receipts receipt
        where receipt.actor_user_id = v_actor_id
          and receipt.idempotency_key = v_expired_key) <> 1 then
    raise exception 'expired receipt was not atomically replaced with one live receipt';
  end if;
  if not exists (
    select 1
    from private.account_approval_decision_receipts receipt
    where receipt.actor_user_id = v_actor_id
      and receipt.idempotency_key = v_other_expired_key
      and receipt.expires_at <= statement_timestamp()
  ) then
    raise exception 'expiry cleanup removed a receipt outside the locked actor/key';
  end if;

  v_replay := public.decide_account_approval(
    v_expired_key,
    v_decision_target_id,
    'approved',
    null
  );
  if (v_replay ->> 'approvalState') is distinct from 'approved'
    or (v_replay ->> 'replayed')::boolean is not true then
    raise exception 'fresh receipt was not replayed after live reread: %', v_replay;
  end if;

  v_submission_definition := lower(pg_get_functiondef(
    'public.submit_profile_for_approval_from_trusted_server(uuid,text,text,text,text,text,text)'::regprocedure
  ));
  v_control_lock_offset := position('select control.* into v_control' in v_submission_definition);
  v_profile_lock_offset := position('select profile.* into v_profile' in v_submission_definition);
  if v_control_lock_offset = 0
    or v_profile_lock_offset = 0
    or v_control_lock_offset >= v_profile_lock_offset
    or position('for update' in substring(v_submission_definition from v_control_lock_offset)) = 0
    or position('for update' in substring(v_submission_definition from v_profile_lock_offset)) = 0 then
    raise exception 'profile submission lock order must be account_controls then profiles';
  end if;
end;
$test$;

rollback;
