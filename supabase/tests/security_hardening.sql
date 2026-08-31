begin;

do $test$
declare
  v_user_id uuid := '10000000-0000-4000-8000-000000000001';
  v_superadmin_a uuid := '10000000-0000-4000-8000-000000000002';
  v_superadmin_b uuid := '10000000-0000-4000-8000-000000000003';
  v_test_id uuid := '10000000-0000-4000-8000-000000000004';
  v_revision_id uuid := '10000000-0000-4000-8000-000000000005';
  v_variant_id uuid := '10000000-0000-4000-8000-000000000007';
  v_purge_target uuid := '10000000-0000-4000-8000-000000000006';
  v_correlation_id uuid := '10000000-0000-4000-8000-000000000008';
  v_signup_user_id uuid := '10000000-0000-4000-8000-000000000009';
  v_signup_operation_id uuid := '10000000-0000-4000-8000-00000000000a';
  v_worker_id uuid := '10000000-0000-4000-8000-00000000000b';
  v_signup_nonce text := repeat('c', 64);
  v_signup_nonce_sha256 text;
  v_privacy_version text;
  v_privacy_body_revision text;
  v_terms_version text;
  v_terms_body_revision text;
  v_avatar_operation_id uuid;
  v_avatar_replacement_id uuid;
  v_avatar_object_key text;
  v_avatar_storage_object_id uuid := '10000000-0000-4000-8000-00000000000c';
  v_avatar_replacement_storage_id uuid := '10000000-0000-4000-8000-00000000000d';
  v_outbox_id uuid;
  v_outbox_token text;
  v_tombstone_id uuid;
  v_result jsonb;
  v_limited boolean := false;
  v_blocked boolean := false;
  v_index integer;
  v_retry_at timestamptz;
  v_day_start timestamptz;
  v_unrelated_audit_id bigint;
  v_read_blocked boolean;
begin
  -- Migration preflight refuses ambiguous legacy Auth work, and every still-
  -- live pre-700 deletion request must enter the durable Storage queue.
  if exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.state in ('prepared', 'external_succeeded', 'retryable')
      and operation.operation_type in ('suspend', 'restore')
      and (
        operation.target_id is null
        or coalesce(operation.payload ->> 'targetId', '') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or operation.target_id::text
          is distinct from operation.payload ->> 'targetId'
      )
  ) or exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.operation_type = 'invite'
      and operation.state in ('prepared', 'external_succeeded', 'retryable')
    group by lower(btrim(operation.payload ->> 'email'))
    having lower(btrim(operation.payload ->> 'email')) is null
      or count(*) > 1
  ) then
    raise exception 'ambiguous pre-700 Auth operation survived migration preflight';
  end if;
  if exists (
    select 1
    from public.account_controls control
    join auth.users auth_user on auth_user.id = control.user_id
    left join private.account_storage_cleanup_tombstones tombstone
      on tombstone.user_id = control.user_id
    where control.deletion_pending
      and auth_user.deleted_at is null
      and tombstone.id is null
  ) then
    raise exception 'pre-700 deletion request was not backfilled into cleanup queue';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
  (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated',
    'quota-test@safetyhub.invalid', '', statement_timestamp(),
    '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    v_superadmin_a, 'authenticated', 'authenticated',
    'superadmin-a@safetyhub.invalid', '', statement_timestamp(),
    '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    v_superadmin_b, 'authenticated', 'authenticated',
    'superadmin-b@safetyhub.invalid', '', statement_timestamp(),
    '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    v_purge_target, 'authenticated', 'authenticated',
    'purge-storage-target@safetyhub.invalid', '', statement_timestamp(),
    '{}'::jsonb, '{}'::jsonb, statement_timestamp(), statement_timestamp()
  );

  update public.user_roles
  set role = 'superadmin'
  where user_id in (v_superadmin_a, v_superadmin_b);

  -- The invariant scenario must have exactly the two synthetic superadmins.
  -- Restored production data can already contain another active superadmin;
  -- demote it only inside this transaction so the assertion remains isolated.
  update public.user_roles
  set role = 'admin'
  where role = 'superadmin'
    and user_id not in (v_superadmin_a, v_superadmin_b);

  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- The application service selects the authenticated actor. Browser callers
  -- cannot choose an arbitrary actor or arbitrary action through a raw RPC.
  for v_index in 1..12 loop
    v_result := public.consume_business_quota_for_actor(
      v_user_id, 'avatar.upload'
    );
    if (v_result ->> 'allowed')::boolean is not true then
      raise exception 'avatar quota denied request % too early', v_index;
    end if;
  end loop;
  v_result := public.consume_business_quota_for_actor(
    v_user_id, 'avatar.upload'
  );
  if (v_result ->> 'allowed')::boolean is not false
    or (v_result ->> 'retryAfter')::integer <= 0 then
    raise exception 'avatar quota failed to deny request 13';
  end if;

  v_limited := false;
  begin
    perform public.consume_business_quota_for_actor(
      v_user_id, 'unknown.action'
    );
  exception when invalid_parameter_value then
    if sqlerrm = 'UNKNOWN_QUOTA_ACTION' then
      v_limited := true;
    else
      raise;
    end if;
  end;
  if not v_limited then
    raise exception 'unknown quota action unexpectedly allowed';
  end if;

  -- Registration is unauthenticated, so it consumes a trusted server-side
  -- coarse network budget before any durable signup operation is prepared.
  for v_index in 1..30 loop
    v_result := public.consume_coarse_ip_quota(
      'auth.register', repeat('e', 64)
    );
    if (v_result ->> 'allowed')::boolean is not true then
      raise exception 'registration coarse quota denied request % too early',
        v_index;
    end if;
  end loop;
  v_result := public.consume_coarse_ip_quota(
    'auth.register', repeat('e', 64)
  );
  if (v_result ->> 'allowed')::boolean is not false
    or (v_result ->> 'retryAfter')::integer <= 0 then
    raise exception 'registration coarse quota failed to deny request 31';
  end if;

  insert into private.coarse_ip_rate_limits (
    ip_hash, action, window_started_at, consumed
  ) values
    -- Keep the retention test deterministic against a restored database that
    -- can already contain legitimate expired quota rows.
    (repeat('1', 64), 'auth.register', timestamptz '1900-01-01 00:00:00+00', 1),
    (repeat('2', 64), 'auth.register', statement_timestamp() - interval '23 hours', 1);
  v_result := public.prune_coarse_ip_rate_limits(1);
  if (v_result ->> 'deleted')::integer <> 1
    or exists (
      select 1 from private.coarse_ip_rate_limits
      where ip_hash = repeat('1', 64) and action = 'auth.register'
    )
    or not exists (
      select 1 from private.coarse_ip_rate_limits
      where ip_hash = repeat('2', 64) and action = 'auth.register'
    ) then
    raise exception 'coarse quota retention boundary failed: %', v_result;
  end if;

  -- Direct PostgREST mutation calls are metered internally and cannot bypass
  -- the persistent actor quota by skipping the same-origin Next.js route.
  v_limited := false;
  for v_index in 1..30 loop
    perform public.update_profile('Quota', 'Test', 'Engineer', 'SafetyHub');
  end loop;
  begin
    perform public.update_profile('Quota', 'Test', 'Engineer', 'SafetyHub');
  exception when program_limit_exceeded then
    if sqlerrm like 'RATE_LIMITED:%' then
      v_limited := true;
    else
      raise;
    end if;
  end;
  if not v_limited then
    raise exception 'direct update_profile RPC bypassed actor quota';
  end if;

  -- Invalid mutations consume quota while domain writes roll back. Sanitized
  -- envelopes are the only error data returned to the browser boundary.
  for v_index in 1..20 loop
    v_result := public.confirm_admin_identities(array[v_user_id]);
    if v_result #>> '{__safetyhubRpcError,code}' <> '42501'
      or v_result #>> '{__safetyhubRpcError,message}' <> 'CAPABILITY_REQUIRED'
      or v_result #>> '{__safetyhubRpcError,version}' <> '1' then
      raise exception 'invalid admin RPC envelope mismatch on request %: %',
        v_index, v_result;
    end if;
  end loop;
  if not exists (
    select 1
    from private.business_rate_limits
    where actor_id = v_user_id
      and action = 'admin.attestation.mutate'
      and consumed = 20
  ) then
    raise exception 'invalid admin RPC calls rolled back actor quota';
  end if;
  if exists (
    select 1 from public.admin_audit_log
    where actor_user_id = v_user_id and action like 'identity.%'
  ) or exists (
    select 1 from public.verified_identities
    where user_id = v_user_id and status = 'verified'
  ) then
    raise exception 'rejected admin RPC leaked domain writes';
  end if;

  v_limited := false;
  begin
    perform public.confirm_admin_identities(array[v_user_id]);
  exception when program_limit_exceeded then
    if sqlerrm like 'RATE_LIMITED:%' then
      v_limited := true;
    else
      raise;
    end if;
  end;
  if not v_limited then
    raise exception 'invalid direct admin RPC calls did not exhaust quota';
  end if;

  -- Registration legal acceptance is owned by a durable prepared operation.
  select version, body_revision
  into v_privacy_version, v_privacy_body_revision
  from public.legal_document_versions
  where document_type = 'privacy' and is_current;
  select version, body_revision
  into v_terms_version, v_terms_body_revision
  from public.legal_document_versions
  where document_type = 'terms' and is_current;
  v_signup_nonce_sha256 := encode(
    extensions.digest(convert_to(v_signup_nonce, 'utf8'), 'sha256'), 'hex'
  );
  v_result := public.prepare_signup_legal_operation(
    v_signup_operation_id,
    v_signup_nonce_sha256,
    '  Signup-Owner@SafetyHub.Invalid  ',
    v_privacy_version,
    v_privacy_body_revision,
    v_terms_version,
    v_terms_body_revision
  );
  if v_result ->> 'status' <> 'prepared' then
    raise exception 'signup legal operation was not prepared: %', v_result;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_signup_user_id, 'authenticated', 'authenticated',
    'signup-owner@safetyhub.invalid', '', statement_timestamp(),
    '{}'::jsonb,
    jsonb_build_object(
      'safetyhubSignupOperationId', v_signup_operation_id::text,
      'safetyhubSignupNonce', v_signup_nonce
    ),
    statement_timestamp(), statement_timestamp()
  );

  -- GoTrue changed auth.identities.id/provider_id across local image versions;
  -- use the installed schema while preserving the same email identity proof.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'identities'
      and column_name = 'provider_id'
  ) then
    execute $identity$
      insert into auth.identities (
        provider_id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values ($1, $2, $3, 'email', $4, $4, $4)
    $identity$ using
      v_signup_user_id::text,
      v_signup_user_id,
      jsonb_build_object(
        'sub', v_signup_user_id::text,
        'email', 'signup-owner@safetyhub.invalid',
        'safetyhubSignupOperationId', v_signup_operation_id::text,
        'safetyhubSignupNonce', v_signup_nonce
      ),
      statement_timestamp();
  else
    execute $identity$
      insert into auth.identities (
        id, user_id, identity_data, provider,
        last_sign_in_at, created_at, updated_at
      ) values ($1, $2, $3, 'email', $4, $4, $4)
    $identity$ using
      v_signup_user_id::text,
      v_signup_user_id,
      jsonb_build_object(
        'sub', v_signup_user_id::text,
        'email', 'signup-owner@safetyhub.invalid',
        'safetyhubSignupOperationId', v_signup_operation_id::text,
        'safetyhubSignupNonce', v_signup_nonce
      ),
      statement_timestamp();
  end if;

  v_result := public.finalize_signup_legal_operation(
    v_signup_operation_id, v_signup_user_id, repeat('d', 64)
  );
  if v_result ->> 'status' <> 'not_owned'
    or (v_result ->> 'accepted')::boolean is not false
    or exists (
      select 1 from public.legal_acceptances
      where user_id = v_signup_user_id and source = 'registration'
    ) then
    raise exception 'forged signup nonce created legal acceptance: %', v_result;
  end if;

  v_result := public.finalize_signup_legal_operation(
    v_signup_operation_id, v_signup_user_id, v_signup_nonce
  );
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'accepted')::boolean is not true
    or (select count(*) from public.legal_acceptances
      where user_id = v_signup_user_id
        and source = 'registration'
        and (document_type, version) in (
          ('privacy'::public.legal_document_type, v_privacy_version),
          ('terms'::public.legal_document_type, v_terms_version)
        )) <> 2
    or exists (
      select 1 from auth.users
      where id = v_signup_user_id
        and raw_user_meta_data ?| array[
          'safetyhubSignupOperationId', 'safetyhubSignupNonce'
        ]
    )
    or exists (
      select 1 from auth.identities
      where user_id = v_signup_user_id
        and identity_data ?| array[
          'safetyhubSignupOperationId', 'safetyhubSignupNonce'
        ]
    ) then
    raise exception 'owned signup finalization contract failed: %', v_result;
  end if;
  v_result := public.finalize_signup_legal_operation(
    v_signup_operation_id, v_signup_user_id, v_signup_nonce
  );
  if v_result ->> 'status' <> 'completed'
    or (v_result ->> 'accepted')::boolean is not true then
    raise exception 'signup finalization replay was not idempotent: %', v_result;
  end if;

  -- Publish an immutable avatar manifest, then leave a replacement write lease
  -- live so account cleanup must wait for the external write boundary.
  v_result := public.begin_profile_avatar_upload(
    v_purge_target, repeat('a', 64), 100
  );
  v_avatar_operation_id := (v_result ->> 'operationToken')::uuid;
  v_avatar_object_key := v_result ->> 'objectKey';
  if v_result ->> 'status' <> 'prepared'
    or v_avatar_object_key <> v_purge_target::text || '/objects/'
      || v_avatar_operation_id::text || '.webp' then
    raise exception 'immutable avatar operation key invalid: %', v_result;
  end if;

  -- The authenticated Storage INSERT boundary accepts only the actor's exact
  -- live immutable operation and fails closed for every mutable account/state
  -- dimension. The service remains responsible for byte proof and publication.
  perform set_config('request.jwt.claim.sub', v_purge_target::text, true);
  if not public.profile_avatar_storage_write_is_authorized(v_avatar_object_key)
    or public.profile_avatar_storage_write_is_authorized(
      v_purge_target::text || '/objects/' || gen_random_uuid()::text || '.webp'
    ) then
    raise exception 'exact avatar Storage INSERT authorization failed';
  end if;
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  if public.profile_avatar_storage_write_is_authorized(v_avatar_object_key) then
    raise exception 'cross-user avatar Storage INSERT authorization succeeded';
  end if;
  perform set_config('request.jwt.claim.sub', v_purge_target::text, true);
  update public.account_controls
  set deletion_pending = true
  where user_id = v_purge_target;
  if public.profile_avatar_storage_write_is_authorized(v_avatar_object_key) then
    raise exception 'deletion-pending avatar Storage INSERT authorization succeeded';
  end if;
  update public.account_controls
  set deletion_pending = false
  where user_id = v_purge_target;
  update private.avatar_upload_operations
  set state = 'cancel_requested'
  where token = v_avatar_operation_id;
  if public.profile_avatar_storage_write_is_authorized(v_avatar_object_key) then
    raise exception 'cancelled avatar Storage INSERT authorization succeeded';
  end if;
  update private.avatar_upload_operations
  set state = 'prepared',
      storage_write_lease_expires_at = statement_timestamp() - interval '1 second'
  where token = v_avatar_operation_id;
  if public.profile_avatar_storage_write_is_authorized(v_avatar_object_key) then
    raise exception 'expired avatar Storage write lease authorized INSERT';
  end if;
  update private.avatar_upload_operations
  set started_at = statement_timestamp() - interval '3 minutes',
      storage_write_lease_expires_at = statement_timestamp() + interval '30 minutes'
  where token = v_avatar_operation_id;
  if public.profile_avatar_storage_write_is_authorized(v_avatar_object_key) then
    raise exception 'expired avatar Storage admission authorized INSERT';
  end if;
  update private.avatar_upload_operations
  set started_at = statement_timestamp(),
      storage_write_lease_expires_at = statement_timestamp() + interval '30 minutes'
  where token = v_avatar_operation_id;
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);

  insert into storage.objects (id, bucket_id, name)
  values (v_avatar_storage_object_id, 'profile-avatars', v_avatar_object_key);

  perform public.finish_profile_avatar_storage_write(
    v_purge_target, v_avatar_operation_id, null
  );

  v_blocked := false;
  begin
    perform public.mark_profile_avatar_staged(
      v_purge_target, v_avatar_operation_id, repeat('a', 64), null
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STAGING_PROOF_INVALID' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked or not exists (
    select 1 from private.avatar_upload_operations
    where token = v_avatar_operation_id and state = 'prepared'
  ) then
    raise exception 'null avatar staging proof failed open';
  end if;

  perform public.mark_profile_avatar_staged(
    v_purge_target, v_avatar_operation_id, repeat('a', 64), 100
  );
  v_result := public.finalize_profile_avatar_upload(
    v_purge_target, v_avatar_operation_id
  );
  if v_result ->> 'status' <> 'committed'
    or not exists (
      select 1 from private.profile_avatar_manifests
      where user_id = v_purge_target
        and object_key = v_avatar_object_key
        and sha256 = repeat('a', 64)
        and byte_length = 100
        and not legacy_imported
    ) then
    raise exception 'avatar manifest was not atomically committed: %', v_result;
  end if;

  v_result := public.begin_profile_avatar_upload(
    v_purge_target, repeat('b', 64), 101
  );
  v_avatar_replacement_id := (v_result ->> 'operationToken')::uuid;
  if not exists (
    select 1 from private.avatar_upload_operations
    where token = v_avatar_replacement_id
      and previous_object_key = v_avatar_object_key
      and storage_write_lease_expires_at > statement_timestamp()
  ) then
    raise exception 'replacement avatar write lease/previous key missing';
  end if;
  insert into storage.objects (id, bucket_id, name)
  values (
    v_avatar_replacement_storage_id,
    'profile-avatars',
    v_purge_target::text || '/objects/' || v_avatar_replacement_id::text || '.webp'
  );

  -- A nonterminal outbox row blocks purge. Once transitioned through the
  -- token-bound state machine, its payload/error are terminally sanitized.
  v_result := private.new_auth_admin_operation(
    'suspend', v_superadmin_a, v_purge_target,
    jsonb_build_object(
      'targetId', v_purge_target,
      'reason', 'contains purge-target@safetyhub.invalid',
      'secret', 'must-not-survive'
    ),
    v_correlation_id
  );
  v_outbox_id := (v_result ->> 'operationId')::uuid;
  v_outbox_token := v_result ->> 'completionToken';
  v_blocked := false;
  begin
    perform public.begin_user_account_purge(v_purge_target);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked
    or (select deletion_pending from public.account_controls
      where user_id = v_purge_target)
    or exists (
      select 1 from private.account_storage_cleanup_tombstones
      where user_id = v_purge_target
    ) then
    raise exception 'prepared auth-admin operation did not block account purge';
  end if;

  v_blocked := false;
  begin
    perform public.advance_auth_admin_operation(
      v_outbox_id,
      v_outbox_token,
      'failed',
      v_user_id,
      'AUTH_ADMIN_TEST_FAILURE'
    );
  exception when check_violation then
    if sqlerrm = 'OUTBOX_TARGET_MISMATCH' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked or not exists (
    select 1 from private.auth_admin_outbox
    where id = v_outbox_id and state = 'prepared'
  ) then
    raise exception 'suspension outbox accepted a different external target';
  end if;

  perform public.advance_auth_admin_operation(
    v_outbox_id,
    v_outbox_token,
    'failed',
    v_purge_target,
    'contains purge-target@safetyhub.invalid and internal detail'
  );
  if not exists (
    select 1 from private.auth_admin_outbox
    where id = v_outbox_id
      and state = 'failed'
      and payload = jsonb_build_object('targetId', v_purge_target)
      and last_error = 'AUTH_ADMIN_UNKNOWN'
      and processing_lease_expires_at is null
  ) or not exists (
    select 1 from public.admin_audit_log
    where action = 'auth_operation.failed'
      and target_type = 'auth_admin_operation'
      and target_id = v_outbox_id::text
      and after_data ->> 'errorCategory' = 'AUTH_ADMIN_UNKNOWN'
  ) then
    raise exception 'terminal outbox sanitization/audit contract failed';
  end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, reason, correlation_id
  ) values (
    v_superadmin_a, 'security.regression_unrelated', 'system',
    'unrelated-audit-row', 'Must survive colliding correlation',
    v_correlation_id
  ) returning id into v_unrelated_audit_id;

  v_result := public.begin_user_account_purge(v_purge_target);
  v_tombstone_id := (v_result ->> 'tombstoneId')::uuid;
  if v_result ->> 'state' <> 'cleanup_pending'
    or not (v_result ->> 'pending')::boolean
    or not exists (
      select 1 from private.avatar_upload_operations
      where token = v_avatar_replacement_id
        and state = 'cancel_requested'
        and storage_write_lease_expires_at > statement_timestamp()
    ) then
    raise exception 'account purge did not create tombstone/cancel avatar: %', v_result;
  end if;
  v_blocked := false;
  begin
    update storage.objects
    set metadata = coalesce(metadata, '{}'::jsonb)
    where id = v_avatar_replacement_storage_id;
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'AVATAR_STORAGE_WRITE_NOT_AUTHORIZED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'cancelled avatar accepted final Storage metadata write';
  end if;

  v_blocked := false;
  begin
    perform public.purge_user_account(v_purge_target);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'ACCOUNT_STORAGE_CLEANUP_PENDING' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked or not exists (
    select 1 from auth.users where id = v_purge_target
  ) then
    raise exception 'database purge ran before durable Storage cleanup';
  end if;

  v_blocked := false;
  begin
    delete from auth.users where id = v_purge_target;
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'ACCOUNT_STORAGE_CLEANUP_PENDING' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked or not exists (
    select 1 from auth.users where id = v_purge_target
  ) then
    raise exception 'direct Auth deletion bypassed Storage tombstone guard';
  end if;

  update private.account_storage_cleanup_tombstones
  set requested_at = statement_timestamp() - interval '1 hour',
      cleanup_not_before = statement_timestamp() - interval '30 minutes',
      next_attempt_at = statement_timestamp() - interval '1 minute'
  where id = v_tombstone_id;
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if v_result <> '[]'::jsonb then
    raise exception 'live avatar write lease failed to block cleanup: %', v_result;
  end if;

  perform public.finish_profile_avatar_storage_write(
    v_purge_target, v_avatar_replacement_id, 'ACCOUNT_DELETION_REQUESTED'
  );
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if jsonb_array_length(v_result) <> 1
    or (v_result -> 0 ->> 'tombstoneId')::uuid <> v_tombstone_id then
    raise exception 'ready Storage tombstone was not claimed: %', v_result;
  end if;
  perform public.advance_account_storage_cleanup(
    v_tombstone_id, v_worker_id, 'empty', null
  );
  if not exists (
    select 1 from private.account_storage_cleanup_tombstones
    where id = v_tombstone_id and state = 'empty_once'
  ) then
    raise exception 'first empty prefix scan skipped empty_once';
  end if;

  update private.account_storage_cleanup_tombstones
  set empty_confirmed_at = statement_timestamp() - interval '3 minutes',
      next_attempt_at = statement_timestamp() - interval '1 minute'
  where id = v_tombstone_id;
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if jsonb_array_length(v_result) <> 1 then
    raise exception 'second pre-purge empty scan was not claimable: %', v_result;
  end if;
  perform public.advance_account_storage_cleanup(
    v_tombstone_id, v_worker_id, 'empty', null
  );
  if not exists (
    select 1 from private.account_storage_cleanup_tombstones
    where id = v_tombstone_id and state = 'storage_cleared'
  ) or exists (
    select 1 from private.avatar_upload_operations
    where user_id = v_purge_target
      and (state not in ('committed', 'aborted')
        or artifacts_cleared_at is null)
  ) then
    raise exception 'two pre-purge scans did not close avatar artifacts';
  end if;

  v_result := public.purge_user_account(v_purge_target);
  if (v_result ->> 'deleted')::boolean is not true
    or (v_result ->> 'postPurgeCleanupPending')::boolean is not true
    or exists (select 1 from auth.users where id = v_purge_target)
    or exists (select 1 from private.auth_admin_outbox where id = v_outbox_id)
    or exists (
      select 1 from public.admin_audit_log
      where target_type = 'auth_admin_operation'
        and target_id = v_outbox_id::text
    )
    or not exists (
      select 1 from public.admin_audit_log
      where id = v_unrelated_audit_id
        and correlation_id = v_correlation_id
        and target_id = 'unrelated-audit-row'
    )
    or not exists (
      select 1 from private.account_storage_cleanup_tombstones
      where id = v_tombstone_id and state = 'post_purge_cleanup'
        and auth_purged_at is not null and db_purged_at is null
    ) then
    raise exception 'database purge/outbox audit/post-purge transition failed: %',
      v_result;
  end if;

  -- Auth deletion starts an independent 15-minute horizon followed by two
  -- further separated empty scans before the durable tombstone is terminal.
  update private.account_storage_cleanup_tombstones
  set next_attempt_at = statement_timestamp() - interval '1 minute'
  where id = v_tombstone_id;
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if v_result <> '[]'::jsonb then
    raise exception 'post-purge 15-minute horizon failed closed: %', v_result;
  end if;

  update private.account_storage_cleanup_tombstones
  set storage_cleared_at = statement_timestamp() - interval '20 minutes',
      auth_purged_at = statement_timestamp() - interval '16 minutes',
      next_attempt_at = statement_timestamp() - interval '1 minute'
  where id = v_tombstone_id;
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if jsonb_array_length(v_result) <> 1 then
    raise exception 'first post-purge empty scan was not claimable: %', v_result;
  end if;
  perform public.advance_account_storage_cleanup(
    v_tombstone_id, v_worker_id, 'empty', null
  );
  if not exists (
    select 1 from private.account_storage_cleanup_tombstones
    where id = v_tombstone_id and state = 'post_purge_empty_once'
  ) then
    raise exception 'first post-purge empty scan skipped durable state';
  end if;

  update private.account_storage_cleanup_tombstones
  set empty_confirmed_at = statement_timestamp() - interval '3 minutes',
      next_attempt_at = statement_timestamp() - interval '1 minute'
  where id = v_tombstone_id;
  v_result := public.claim_account_storage_cleanup(v_worker_id, 25);
  if jsonb_array_length(v_result) <> 1 then
    raise exception 'second post-purge empty scan was not claimable: %', v_result;
  end if;
  perform public.advance_account_storage_cleanup(
    v_tombstone_id, v_worker_id, 'empty', null
  );
  if not exists (
    select 1 from private.account_storage_cleanup_tombstones
    where id = v_tombstone_id and state = 'db_purged'
      and db_purged_at is not null
  ) then
    raise exception 'post-purge tombstone did not reach db_purged';
  end if;

  -- Calendar-day attempt limits expose only the validated retryAt recovery detail.
  update public.profiles
  set name = 'Quota', surname = 'Daily', job = 'Engineer',
      organization = 'SafetyHub',
      avatar_updated_at = statement_timestamp(),
      onboarding_completed_at = statement_timestamp()
  where id = v_user_id;
  insert into public.legal_acceptances (
    user_id, document_type, version, source
  )
  select v_user_id, document.document_type, document.version, 'profile'
  from public.legal_document_versions document
  where document.is_current
  on conflict do nothing;

  -- This scenario validates the downstream calendar-limit envelope. Satisfy
  -- the learner-approval prerequisite so it cannot mask that assertion.
  update public.account_controls
  set approval_state = 'approved',
      approval_requested_at = null,
      approval_due_at = null,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_user_id;

  insert into public.tests (
    id, slug, title, description, draft_content, duration_minutes,
    pass_score, status
  ) values (
    v_test_id, 'quota-calendar-regression', 'Quota calendar regression', '',
    '{"questions":[]}'::jsonb, 5, 1, 'draft'
  );
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, questions,
    question_count, duration_minutes, pass_score
  ) values (
    v_revision_id, v_test_id, 1, 'quota-calendar-regression',
    'Quota calendar regression', '', '[{}]'::jsonb, 1, 5, 1
  );
  update public.tests
  set current_revision_id = v_revision_id, content_version = 1,
      status = 'published'
  where id = v_test_id;

  insert into public.test_revision_variants(
    id, stable_id, revision_id, variant_number, questions, question_count
  ) values (
    v_variant_id, v_variant_id, v_revision_id, 1, '[{}]'::jsonb, 1
  );

  v_day_start := (statement_timestamp() at time zone 'Asia/Oral')::date::timestamp
    at time zone 'Asia/Oral';
  v_retry_at := (
    (statement_timestamp() at time zone 'Asia/Oral')::date + 1
  )::timestamp at time zone 'Asia/Oral';
  for v_index in 1..8 loop
    insert into public.test_attempts (
      user_id, test_id, revision_id, variant_id, duration_minutes, pass_score,
      attempts_per_day, reset_timezone, status, started_at, expires_at, completed_at
    ) values (
      v_user_id, v_test_id, v_revision_id, v_variant_id, 5, 1, 8, 'Asia/Oral',
      'expired', v_day_start + make_interval(mins => v_index),
      v_day_start + make_interval(mins => v_index + 5),
      v_day_start + make_interval(mins => v_index + 5)
    );
  end loop;

  v_result := public.start_test_attempt('quota-calendar-regression');
  if v_result #>> '{__safetyhubRpcError,code}' <> '54000'
    or v_result #>> '{__safetyhubRpcError,message}' <> 'ATTEMPT_DAILY_LIMIT'
    or jsonb_typeof(v_result #> '{__safetyhubRpcError,details}') <> 'object'
    or (select count(*) from jsonb_object_keys(
      v_result #> '{__safetyhubRpcError,details}'
    )) <> 1
    or (v_result #>> '{__safetyhubRpcError,details,retryAt}')::timestamptz
      is distinct from v_retry_at then
    raise exception 'calendar-day attempt error lost validated retryAt: %', v_result;
  end if;
  if not exists (
    select 1 from private.business_rate_limits
    where actor_id = v_user_id and action = 'attempt.start' and consumed = 1
  ) or (select count(*) from public.test_attempts
    where user_id = v_user_id and test_id = v_test_id) <> 8 then
    raise exception 'calendar attempt error failed quota/domain atomicity';
  end if;

  v_result := private.rpc_error_envelope(
    '54000', 'ATTEMPT_DAILY_LIMIT',
    '{"retryAt":"2030-01-01T00:00:00Z","secret":"must-not-leak"}'
  );
  if v_result #> '{__safetyhubRpcError,details}' is not null then
    raise exception 'unapproved daily-limit detail leaked: %', v_result;
  end if;

  -- Active-superadmin protection is invariant under both transition orders.
  update public.account_controls
  set status = 'suspended'
  where user_id = v_superadmin_b;
  v_blocked := false;
  begin
    update public.account_controls
    set deletion_pending = true
    where user_id = v_superadmin_a;
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LAST_ACTIVE_SUPERADMIN_PROTECTED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'active superadmin could be deleted with only suspended peer';
  end if;

  update public.account_controls
  set status = 'active'
  where user_id = v_superadmin_b;
  update public.account_controls
  set deletion_pending = true
  where user_id = v_superadmin_a;

  v_blocked := false;
  begin
    update public.account_controls
    set status = 'suspended'
    where user_id = v_superadmin_b;
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LAST_ACTIVE_SUPERADMIN_PROTECTED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'last usable superadmin could be suspended';
  end if;

  v_blocked := false;
  begin
    update public.user_roles
    set role = 'admin'
    where user_id = v_superadmin_b;
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LAST_ACTIVE_SUPERADMIN_PROTECTED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'last usable superadmin could be demoted';
  end if;

  -- Owner/list reads fail closed immediately for suspended or deleting JWTs.
  perform set_config('request.jwt.claim.sub', v_user_id::text, true);
  update public.account_controls
  set status = 'suspended'
  where user_id = v_user_id;
  v_read_blocked := false;
  begin
    perform public.get_user_identity(null);
  exception when insufficient_privilege then
    if sqlerrm = 'ACCOUNT_UNAVAILABLE' then
      v_read_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_read_blocked then
    raise exception 'suspended JWT identity read remained usable';
  end if;

  v_read_blocked := false;
  begin
    perform public.search_profile_organizations('', 8);
  exception when insufficient_privilege then
    if sqlerrm = 'ACCOUNT_UNAVAILABLE' then
      v_read_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_read_blocked then
    raise exception 'suspended JWT organization search remained usable';
  end if;

  update public.account_controls
  set status = 'active', deletion_pending = true
  where user_id = v_user_id;
  v_read_blocked := false;
  begin
    perform public.get_user_identity(null);
  exception when insufficient_privilege then
    if sqlerrm = 'ACCOUNT_UNAVAILABLE' then
      v_read_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_read_blocked then
    raise exception 'deletion-pending JWT identity read remained usable';
  end if;
end;
$test$;

rollback;
