-- Administrator-initiated account deletion that finishes inside the request.
--
-- `begin_user_account_purge` only marks an account and enqueues a tombstone
-- fifteen minutes into the future; the account itself is removed later by the
-- `storage-reconciler` Edge Function. That function has no schedule in this
-- repository, so in practice a "deleted" person kept their login and kept
-- appearing in every operator list forever.
--
-- This migration adds a second, additive path. The staged worker keeps its
-- contract untouched for self-service deletion and for the reconciler; the new
-- path performs the same work in one transaction for an operator who asked for
-- it explicitly. The safety window it skips guarded against an avatar upload
-- landing in Storage after the prefix was swept — the tombstone is therefore
-- left in `post_purge_cleanup` so the reconciler still removes leftover objects
-- whenever it runs, and the application deletes the prefix itself right after
-- the transaction commits.

-- Deny-by-default catalogue, extended with the bulk purge budget. The
-- per-account `admin.delete` tariff stays exactly as it was: the staged path
-- and its contract test still use it.
create or replace function private.quota_policy(p_action text)
returns table (quota integer, window_seconds integer)
language sql
immutable
set search_path = ''
as $$
  select
    case p_action
      when 'certificate.pdf' then 20
      when 'certificate.export' then 5
      when 'presentation.download' then 12
      when 'attempt.start' then 30
      when 'attempt.complete' then 30
      when 'auth.register' then 10
      when 'auth.otp.start' then 20
      when 'auth.otp.start.email' then 5
      when 'auth.otp.verify' then 30
      when 'auth.otp.verify.email' then 6
      when 'auth.zh.registration.options' then 10
      when 'auth.zh.registration.verify' then 15
      when 'auth.zh.authentication.options' then 60
      when 'auth.zh.authentication.verify' then 30
      when 'auth.zh.authentication.credential' then 10
      when 'auth.zh.recovery.options' then 10
      when 'auth.zh.recovery.verify' then 10
      when 'auth.zh.recovery.locator' then 5
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'admin.zh_credential.reset' then 10
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.purge' then 50
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in ('auth.otp.start', 'auth.otp.start.email') then 900
      when p_action in ('auth.otp.verify', 'auth.otp.verify.email') then 900
      when p_action in (
        'auth.zh.registration.options', 'auth.zh.recovery.options',
        'auth.zh.recovery.verify', 'auth.zh.recovery.locator'
      ) then 3600
      when p_action in (
        'auth.zh.registration.verify', 'auth.zh.authentication.options',
        'auth.zh.authentication.verify', 'auth.zh.authentication.credential'
      ) then 900
      when p_action in (
        'presentation.download', 'profile.update', 'legal.accept',
        'content.article.mutate', 'site.settings.update',
        'admin.access.mutate', 'admin.test.mutate',
        'admin.zh_credential.reset', 'admin.invite', 'admin.suspend',
        'admin.delete', 'admin.purge', 'admin.reconcile', 'certificate.export'
      ) then 300
      else 60
    end;
$$;

revoke all on function private.quota_policy(text)
  from public, anon, authenticated, service_role;

-- `role` is claimed by the operator-role migration that follows this one; both
-- values are admitted here so the constraint is edited exactly once.
alter table private.admin_operation_receipts
  drop constraint admin_operation_receipts_action;
alter table private.admin_operation_receipts
  add constraint admin_operation_receipts_action
  check (action in ('confirm', 'update', 'issue', 'revoke', 'purge', 'role'));

create function private.purge_user_account_immediate(
  p_actor_id uuid,
  p_target_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_status public.account_status;
  v_deletion_pending boolean;
  v_product_role public.product_role;
  v_tombstone private.account_storage_cleanup_tombstones%rowtype;
  v_operation_ids uuid[];
begin
  select lower(btrim(auth_user.email)) into v_email
  from auth.users auth_user
  where auth_user.id = p_target_id and auth_user.deleted_at is null
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ALREADY_ABSENT'
    );
  end if;

  select control.status, control.deletion_pending
  into v_status, v_deletion_pending
  from public.account_controls control
  where control.user_id = p_target_id
  for update;
  if not found then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'USER_NOT_FOUND'
    );
  end if;

  select role.product_role into v_product_role
  from public.user_roles role
  where role.user_id = p_target_id
  for update;

  if private.has_pending_auth_admin_operation(p_target_id, v_email) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped',
      'reason', 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS'
    );
  end if;

  -- The only other `on delete restrict` reference to auth.users besides the
  -- outbox. Without this check the delete surfaces as a raw foreign key error.
  if exists (
    select 1 from private.initial_course_import_operations operation
    where operation.created_by = p_target_id
  ) then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'ACCOUNT_HAS_IMPORT_RECEIPT'
    );
  end if;

  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id;

  insert into private.account_storage_cleanup_tombstones (
    user_id, storage_prefix, requested_at, cleanup_not_before, next_attempt_at
  ) values (
    p_target_id, p_target_id::text || '/',
    statement_timestamp(), statement_timestamp(), statement_timestamp()
  ) on conflict (user_id) do nothing;

  update private.avatar_upload_operations
  set state = 'cancel_requested', updated_at = statement_timestamp(),
      next_attempt_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      last_error_code = 'ACCOUNT_DELETION_REQUESTED'
  where user_id = p_target_id
    and state in ('prepared', 'staged', 'reconcile_required');

  -- `account_storage_cleanup_times` requires the cleared timestamps to be at or
  -- after `cleanup_not_before`, so a tombstone left over from the staged path
  -- has its horizon pulled back to now before the state advances.
  update private.account_storage_cleanup_tombstones
  set cleanup_not_before = least(cleanup_not_before, statement_timestamp()),
      state = 'storage_cleared',
      empty_confirmed_at = statement_timestamp(),
      storage_cleared_at = statement_timestamp(),
      auth_purged_at = null,
      db_purged_at = null,
      lease_owner = null,
      lease_expires_at = null,
      next_attempt_at = statement_timestamp(),
      updated_at = statement_timestamp(),
      last_error_code = null
  where user_id = p_target_id
  returning * into v_tombstone;
  if v_tombstone.id is null then
    return jsonb_build_object(
      'id', p_target_id, 'status', 'skipped', 'reason', 'TOMBSTONE_MISSING'
    );
  end if;

  update private.avatar_upload_operations
  set state = case when state = 'committed' then state else 'aborted' end,
      finalized_at = coalesce(finalized_at, statement_timestamp()),
      artifacts_cleared_at = statement_timestamp(),
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where user_id = p_target_id;

  select coalesce(array_agg(operation.id order by operation.id), '{}'::uuid[])
  into v_operation_ids
  from private.auth_admin_outbox operation
  where operation.actor_user_id = p_target_id
    or operation.target_id = p_target_id
    or (
      operation.operation_type in ('suspend', 'restore')
      and operation.payload ->> 'targetId' = p_target_id::text
    )
    or (
      operation.operation_type = 'invite'
      and lower(btrim(operation.payload ->> 'email')) = v_email
    );

  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  perform set_config('safetyhub.storage_purge_user_id', p_target_id::text, true);
  perform set_config(
    'safetyhub.purge_operation_ids',
    array_to_string(v_operation_ids, ','),
    true
  );

  update public.test_revisions
  set published_by = null
  where published_by = p_target_id;
  update public.certificates
  set issued_by = case when issued_by = p_target_id then null else issued_by end,
      revoked_by = case when revoked_by = p_target_id then null else revoked_by end
  where issued_by = p_target_id or revoked_by = p_target_id;

  delete from public.admin_audit_log audit
  where audit.actor_user_id = p_target_id
    or audit.target_user_id = p_target_id
    or (
      audit.target_type = 'auth_admin_operation'
      and audit.target_id = any(
        array(select operation_id::text from unnest(v_operation_ids) operation_id)
      )
    );
  delete from private.auth_admin_outbox operation
  where operation.id = any(v_operation_ids);
  delete from private.avatar_upload_operations operation
  where operation.user_id = p_target_id;
  delete from private.profile_avatar_manifests manifest
  where manifest.user_id = p_target_id;
  delete from private.signup_legal_operations operation
  where operation.completed_user_id = p_target_id
    or operation.normalized_email = v_email;
  delete from auth.users where id = p_target_id;

  update private.account_storage_cleanup_tombstones
  set state = 'post_purge_cleanup',
      auth_purged_at = statement_timestamp(),
      empty_confirmed_at = null,
      next_attempt_at = statement_timestamp() + interval '15 minutes',
      lease_owner = null, lease_expires_at = null,
      updated_at = statement_timestamp(), last_error_code = null
  where id = v_tombstone.id;

  -- Written after the delete on purpose: the statements above remove every
  -- audit row that references the target, so an entry inserted earlier would be
  -- erased along with them. `target_user_id` must stay null because the column
  -- is a foreign key to the row that no longer exists, and no personal data of
  -- the deleted account is recorded here — retaining it would defeat the
  -- deletion this row is describing.
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, reason, batch_id
  ) values (
    p_actor_id, null, 'user.purged', 'user', p_target_id::text,
    jsonb_build_object(
      'productRole', v_product_role,
      'accountStatus', v_status,
      'deletionAlreadyPending', v_deletion_pending
    ),
    btrim(p_reason), p_idempotency_key
  );

  -- The GUCs stay set for the rest of the transaction otherwise, and would keep
  -- authorizing audit deletions for this identifier while later targets run.
  perform set_config('safetyhub.purge_actor_id', '', true);
  perform set_config('safetyhub.storage_purge_user_id', '', true);
  perform set_config('safetyhub.purge_operation_ids', '', true);

  return jsonb_build_object('id', p_target_id, 'status', 'completed', 'reason', null);
end;
$$;

revoke all on function private.purge_user_account_immediate(uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;

create function public.admin_purge_user_accounts(
  p_idempotency_key uuid,
  p_target_ids uuid[],
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('user.delete');
  v_targets jsonb;
  v_request_hash text;
  v_receipt private.admin_operation_receipts%rowtype;
  v_items jsonb := '[]'::jsonb;
  v_target uuid;
  v_completed integer;
  v_skipped integer;
begin
  if p_idempotency_key is null
     or coalesce(cardinality(p_target_ids), 0) not between 1 and 500
     or (select count(*) from unnest(p_target_ids) target)
       <> (select count(distinct target) from unnest(p_target_ids) target) then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INVALID_BULK_OPERATION';
  end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'PURGE_REASON_REQUIRED';
  end if;
  if v_actor_id = any(p_target_ids) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'CANNOT_DELETE_SELF';
  end if;

  select jsonb_agg(target order by target::text) into v_targets
  from unnest(p_target_ids) target;
  v_request_hash := encode(extensions.digest(convert_to(
    jsonb_build_object(
      'action', 'purge',
      'targets', v_targets,
      'reason', p_reason
    )::text,
    'utf8'
  ), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text,
    0
  ));

  select * into v_receipt
  from private.admin_operation_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  perform private.enforce_actor_quota('admin.purge');

  -- Same order as the staged purge functions; changing it would deadlock
  -- against the reconciler and against the Auth outbox finalizer.
  perform private.lock_auth_admin_outbox();
  perform private.lock_active_superadmin_invariant();
  perform private.lock_signup_legal_operations();

  if not exists (
    select 1
    from public.user_roles role
    join public.account_controls control on control.user_id = role.user_id
    where role.product_role = 'admin'
      and control.status = 'active'
      and not control.deletion_pending
      and role.user_id <> all(p_target_ids)
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LAST_ACTIVE_ADMIN_PROTECTED';
  end if;

  for v_target in select target from unnest(p_target_ids) target order by target
  loop
    begin
      v_items := v_items || jsonb_build_array(
        private.purge_user_account_immediate(
          v_actor_id, v_target, p_reason, p_idempotency_key
        )
      );
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_target, 'status', 'skipped', 'reason', 'ACCOUNT_PURGE_FAILED'
      ));
    end;
  end loop;

  v_items := private.sanitize_bulk_mutation_result(v_items);

  select
    count(*) filter (where item ->> 'status' = 'completed'),
    count(*) filter (where item ->> 'status' = 'skipped')
  into v_completed, v_skipped
  from jsonb_array_elements(v_items) item;

  v_receipt.result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'action', 'purge',
    'replayed', false,
    'items', v_items
  );

  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, 'purge', v_request_hash, v_receipt.result
  );

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, reason, batch_id
  ) values (
    v_actor_id,
    'user.purge.bulk',
    'bulk_operation',
    p_idempotency_key::text,
    jsonb_build_object(
      'requested', cardinality(p_target_ids),
      'completed', coalesce(v_completed, 0),
      'skipped', coalesce(v_skipped, 0)
    ),
    btrim(p_reason),
    p_idempotency_key
  );

  return private.ensure_rpc_payload(v_receipt.result);
end;
$$;

revoke execute on function public.admin_purge_user_accounts(uuid,uuid[],text)
  from public, anon, service_role;
grant execute on function public.admin_purge_user_accounts(uuid,uuid[],text)
  to authenticated;

comment on function public.admin_purge_user_accounts(uuid,uuid[],text) is
  'Reasoned, idempotent, bounded operator deletion that removes the accounts in the same transaction and leaves a post-purge Storage tombstone.';
comment on function private.purge_user_account_immediate(uuid,uuid,text,uuid) is
  'Single-target body of the immediate operator purge; never callable outside admin_purge_user_accounts.';
