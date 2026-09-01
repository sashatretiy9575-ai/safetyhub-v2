begin;

do $test$
begin
  if to_regprocedure('public.get_auth_context()') is null
    or to_regprocedure('public.get_profile_dashboard()') is null
    or to_regprocedure('public.update_profile(text,text,text,text)') is null
    or to_regprocedure('public.start_test_attempt(text)') is null
    or to_regprocedure('public.complete_test_attempt(uuid,jsonb)') is null
    or to_regprocedure('public.list_admin_attestations_page(integer,text,text,uuid,text,text,timestamp with time zone,timestamp with time zone,text,jsonb)') is null
    or to_regprocedure('public.get_admin_attestation_filters()') is null
    or to_regprocedure('public.issue_certificates(uuid[])') is null
    or to_regprocedure('public.resolve_certificate_export(uuid[])') is null
    or to_regprocedure('public.get_certificate_download_payload(uuid)') is null
    or to_regprocedure('public.get_public_certificate(uuid)') is null
    or to_regprocedure('public.get_site_settings()') is null
    or to_regprocedure('public.update_site_settings(text,text,text,boolean,bigint)') is null
    or to_regprocedure('public.begin_user_account_purge(uuid)') is null
    or to_regprocedure('public.purge_user_account(uuid)') is null
    or to_regprocedure('public.get_capacity_metrics()') is null
    or to_regprocedure('public.resolve_admin_attestation_selection(text,text,uuid,text,text,timestamp with time zone,timestamp with time zone,text)') is null
    or to_regprocedure('public.publish_legal_document_version(public.legal_document_type,text,text,timestamp with time zone)') is null
    or to_regprocedure('public.consume_business_quota_for_actor(uuid,text)') is null
    or to_regprocedure('public.consume_coarse_ip_quota(text,text)') is null
    or to_regprocedure('public.prune_coarse_ip_rate_limits(integer)') is null
    or to_regprocedure('public.prepare_signup_legal_operation(uuid,text,text,text,text,text,text)') is null
    or to_regprocedure('public.finalize_signup_legal_operation(uuid,uuid,text)') is null
    or to_regprocedure('public.prune_signup_legal_operations(integer)') is null
    or to_regprocedure('public.get_profile_avatar_manifest(uuid)') is null
    or to_regprocedure('public.get_my_profile_avatar_manifest()') is null
    or to_regprocedure('public.profile_avatar_storage_write_is_authorized(text)') is null
    or to_regprocedure('private.guard_profile_avatar_storage_write()') is null
    or to_regprocedure('public.begin_profile_avatar_upload(uuid,text,integer)') is null
    or to_regprocedure('public.finish_profile_avatar_storage_write(uuid,uuid,text)') is null
    or to_regprocedure('public.mark_profile_avatar_staged(uuid,uuid,text,integer)') is null
    or to_regprocedure('public.finalize_profile_avatar_upload(uuid,uuid)') is null
    or to_regprocedure('public.abort_profile_avatar_upload(uuid,uuid,text)') is null
    or to_regprocedure('public.claim_profile_avatar_reconciliation(uuid,integer)') is null
    or to_regprocedure('public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)') is null
    or to_regprocedure('public.claim_account_storage_cleanup(uuid,integer)') is null
    or to_regprocedure('public.advance_account_storage_cleanup(uuid,uuid,text,text)') is null
    or to_regprocedure('public.prune_account_storage_cleanup_tombstones(integer)') is null
    or to_regprocedure('public.prune_terminal_auth_admin_outbox(integer)') is null then
    raise exception 'required public RPC contract missing';
  end if;

  if to_regclass('private.signup_legal_operations') is null
    or to_regclass('private.profile_avatar_manifests') is null
    or to_regclass('private.avatar_upload_operations') is null
    or to_regclass('private.account_storage_cleanup_tombstones') is null
    or to_regclass('public.admin_audit_auth_operation_target_idx') is null then
    raise exception 'durable signup/avatar/Storage operation table missing';
  end if;

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
  ) then
    raise exception 'AUTH_ADMIN_LEGACY_TARGET_MISMATCH preflight postcondition failed';
  end if;

  if exists (
    select 1
    from private.auth_admin_outbox operation
    where operation.operation_type = 'invite'
      and operation.state in ('prepared', 'external_succeeded', 'retryable')
    group by lower(btrim(operation.payload ->> 'email'))
    having lower(btrim(operation.payload ->> 'email')) is null
      or count(*) > 1
  ) then
    raise exception 'AUTH_ADMIN_LEGACY_INVITE_AMBIGUOUS preflight postcondition failed';
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
    raise exception 'pre-700 deletion-pending Storage tombstone backfill incomplete';
  end if;

  if exists (
    select 1
    from (values
      ('certificate.pdf', 20, 60),
      ('certificate.export', 5, 300),
      ('attempt.start', 30, 60),
      ('attempt.complete', 30, 60),
      ('auth.register', 10, 3600),
      ('avatar.upload', 12, 3600),
      ('profile.update', 30, 300),
      ('legal.accept', 10, 300),
      ('content.article.mutate', 20, 300),
      ('admin.identity.mutate', 20, 60),
      ('admin.certificate.revoke', 20, 60),
      ('admin.access.mutate', 10, 300),
      ('admin.test.mutate', 20, 300),
      ('admin.attestation.mutate', 20, 60),
      ('site.settings.update', 10, 300),
      ('admin.invite', 10, 300),
      ('admin.suspend', 20, 300),
      ('admin.delete', 10, 300),
      ('admin.reconcile', 20, 300)
    ) expected(action, quota, window_seconds)
    cross join lateral private.quota_policy(expected.action) actual
    where (actual.quota, actual.window_seconds)
      is distinct from (expected.quota, expected.window_seconds)
  ) then
    raise exception 'explicit business quota policy invalid';
  end if;

  if exists (
    select 1 from private.quota_policy('unknown.action')
    where quota is not null
  ) then
    raise exception 'unknown quota action was not denied';
  end if;

  if position('private.consume_business_quota_for_actor' in
      pg_get_functiondef(
        'public.consume_business_quota_for_actor(uuid,text)'::regprocedure
      )) = 0
    or position('private.consume_business_quota_for_actor' in
      pg_get_functiondef('private.enforce_actor_quota(text)'::regprocedure)) = 0
    or position('ACCOUNT_UNAVAILABLE' in
      pg_get_functiondef(
        'private.consume_business_quota_for_actor(uuid,text)'::regprocedure
      )) = 0 then
    raise exception 'server-selected persistent actor quota boundary invalid';
  end if;

  if position('private.lock_signup_legal_operations()' in
      pg_get_functiondef(
        'public.prepare_signup_legal_operation(uuid,text,text,text,text,text,text)'::regprocedure
      )) = 0
    or position('private.lock_signup_legal_operations()' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('auth.identities' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('safetyhubSignupOperationId' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('safetyhubSignupNonce' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('identity_data ->> ''sub''' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('privacy.is_current' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('terms.is_current' in
      pg_get_functiondef(
        'public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure
      )) = 0 then
    raise exception 'signup ownership/current-legal contract invalid';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'private.profile_avatar_manifests'::regclass
      and conname = 'profile_avatar_manifest_key'
      and pg_get_constraintdef(oid) like '%/objects/%'
      and pg_get_constraintdef(oid) like '%/avatar.webp%'
      and pg_get_constraintdef(oid) like '%legacy_imported%'
  ) or not exists (
    select 1
    from pg_constraint
    where conrelid = 'private.avatar_upload_operations'::regclass
      and conname = 'avatar_upload_object_key'
      and pg_get_constraintdef(oid) like '%/objects/%'
  ) or not exists (
    select 1
    from pg_index index_row
    join pg_class index_relation on index_relation.oid = index_row.indexrelid
    where index_relation.relname = 'avatar_upload_storage_write_lease_idx'
      and index_row.indrelid = 'private.avatar_upload_operations'::regclass
      and pg_get_expr(index_row.indpred, index_row.indrelid)
        like '%storage_write_lease_expires_at IS NOT NULL%'
  ) then
    raise exception 'immutable avatar key/write-lease schema invalid';
  end if;

  if position('storage_write_lease_expires_at = null' in
      pg_get_functiondef(
        'public.finish_profile_avatar_storage_write(uuid,uuid,text)'::regprocedure
      )) = 0
    or position('is distinct from p_observed_sha256' in
      pg_get_functiondef(
        'public.mark_profile_avatar_staged(uuid,uuid,text,integer)'::regprocedure
      )) = 0
    or position('is distinct from p_observed_bytes' in
      pg_get_functiondef(
        'public.mark_profile_avatar_staged(uuid,uuid,text,integer)'::regprocedure
      )) = 0
    or position('v_operation.lease_owner is null' in
      pg_get_functiondef(
        'public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)'::regprocedure
      )) = 0
    or position('v_operation.lease_expires_at is null' in
      pg_get_functiondef(
        'public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)'::regprocedure
      )) = 0 then
    raise exception 'avatar proof/reconciler lease contract invalid';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'private.account_storage_cleanup_tombstones'::regclass
      and conname = 'account_storage_cleanup_state_shape'
      and pg_get_constraintdef(oid) like '%post_purge_cleanup%'
      and pg_get_constraintdef(oid) like '%post_purge_empty_once%'
      and pg_get_constraintdef(oid) like '%db_purged%'
  ) or position('storage_write_lease_expires_at' in
      pg_get_functiondef(
        'public.claim_account_storage_cleanup(uuid,integer)'::regprocedure
      )) = 0
    or position('interval ''15 minutes''' in
      pg_get_functiondef(
        'public.claim_account_storage_cleanup(uuid,integer)'::regprocedure
      )) = 0
    or position('interval ''2 minutes''' in
      pg_get_functiondef(
        'public.advance_account_storage_cleanup(uuid,uuid,text,text)'::regprocedure
      )) = 0
    or position('p_worker_id is null' in
      pg_get_functiondef(
        'public.advance_account_storage_cleanup(uuid,uuid,text,text)'::regprocedure
      )) = 0
    or position('p_outcome is distinct from ''retry''' in
      pg_get_functiondef(
        'public.advance_account_storage_cleanup(uuid,uuid,text,text)'::regprocedure
      )) = 0 then
    raise exception 'two-phase account Storage cleanup contract invalid';
  end if;

  if position('safetyhub.storage_purge_user_id' in
      pg_get_functiondef('private.guard_auth_user_avatar_cleanup()'::regprocedure)) = 0
    or position('state = ''storage_cleared''' in
      pg_get_functiondef('private.guard_auth_user_avatar_cleanup()'::regprocedure)) = 0
    or position('state = ''post_purge_cleanup''' in
      pg_get_functiondef('public.purge_user_account(uuid)'::regprocedure)) = 0
    or position('postPurgeCleanupPending' in
      pg_get_functiondef('public.purge_user_account(uuid)'::regprocedure)) = 0 then
    raise exception 'Auth deletion/post-purge Storage guard invalid';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'private.auth_admin_outbox'::regclass
      and conname = 'auth_admin_outbox_actor_user_id_fkey'
      and confdeltype = 'r'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'private'
      and table_name = 'auth_admin_outbox'
      and column_name = 'processing_lease_expires_at'
  ) or not exists (
    select 1
    from pg_index index_row
    join pg_class index_relation on index_relation.oid = index_row.indexrelid
    where index_relation.relname = 'auth_admin_outbox_live_invite_email_idx'
      and index_row.indrelid = 'private.auth_admin_outbox'::regclass
      and not index_row.indisunique
  ) then
    raise exception 'durable auth-admin outbox schema invalid';
  end if;

  if position('private.lock_auth_admin_outbox()' in
      pg_get_functiondef(
        'public.prepare_user_invite(text,text,text,text,public.app_role,text,text,uuid,text,text,text)'::regprocedure
      )) = 0
    or position('ACCOUNT_HAS_PENDING_AUTH_OPERATIONS' in
      pg_get_functiondef(
        'public.prepare_user_invite(text,text,text,text,public.app_role,text,text,uuid,text,text,text)'::regprocedure
      )) = 0
    or position('p_suspended is null' in
      pg_get_functiondef(
        'public.request_account_suspension_confirmed(uuid,boolean,text,uuid,text,text,text)'::regprocedure
      )) = 0
    or position('OUTBOX_TARGET_MISMATCH' in
      pg_get_functiondef(
        'public.advance_auth_admin_operation(uuid,text,text,uuid,text)'::regprocedure
      )) = 0
    or position('processing_lease_expires_at is null' in
      pg_get_functiondef(
        'public.advance_auth_admin_operation(uuid,text,text,uuid,text)'::regprocedure
      )) = 0
    or position('v_sanitized_payload' in
      pg_get_functiondef(
        'public.advance_auth_admin_operation(uuid,text,text,uuid,text)'::regprocedure
      )) = 0 then
    raise exception 'auth-admin outbox lock/lease/target/sanitizer contract invalid';
  end if;

  if position('private.enforce_actor_quota(' in
      pg_get_functiondef('public.update_profile(text,text,text,text)'::regprocedure)) = 0
    or position('private.enforce_actor_quota(' in
      pg_get_functiondef('public.complete_profile_onboarding(text,text,text,text)'::regprocedure)) = 0
    or position('private.update_profile_unmetered(' in
      pg_get_functiondef('public.complete_profile_onboarding(text,text,text,text)'::regprocedure)) = 0
    or position('private.enforce_actor_quota(' in (
      pg_get_functiondef('public.start_test_attempt(text)'::regprocedure)
      || pg_get_functiondef(
        'public.start_test_attempt_locale(text,public.app_locale)'::regprocedure
      )
    )) = 0
    or position('private.enforce_actor_quota(' in
      pg_get_functiondef('public.complete_test_attempt(uuid,jsonb)'::regprocedure)) = 0
    or position('private.enforce_actor_quota(' in
      pg_get_functiondef('public.issue_certificates(uuid[])'::regprocedure)) = 0
    or position('private.enforce_actor_quota(' in
      pg_get_functiondef('public.resolve_certificate_export(uuid[])'::regprocedure)) = 0
    or position('public.start_test_attempt(' in
      pg_get_functiondef('public.resume_test_attempt(text)'::regprocedure)) = 0
    or position('public.revoke_certificates(' in
      pg_get_functiondef('public.revoke_certificate(uuid,text)'::regprocedure)) = 0 then
    raise exception 'direct mutation RPC quota wrapper missing';
  end if;

  if position('private.rpc_error_envelope(' in
      pg_get_functiondef('public.update_profile(text,text,text,text)'::regprocedure)) = 0
    or position('private.rpc_error_envelope(' in
      pg_get_functiondef('public.complete_test_attempt(uuid,jsonb)'::regprocedure)) = 0
    or position('private.rpc_error_envelope(' in
      pg_get_functiondef('public.confirm_admin_identities(uuid[])'::regprocedure)) = 0
    or position('private.rpc_error_envelope(' in
      pg_get_functiondef(
        'public.set_user_capabilities_confirmed(uuid,text[],text,uuid,text,text,text)'::regprocedure
      )) = 0
    or position('private.rpc_error_envelope(' in
      pg_get_functiondef('public.resolve_certificate_export(uuid[])'::regprocedure)) = 0
    or position('__safetyhubRpcError' in
      pg_get_functiondef('public.revoke_certificate(uuid,text)'::regprocedure)) = 0 then
    raise exception 'persistent actor quota error envelope missing';
  end if;

  if position('pg_exception_detail' in
      pg_get_functiondef('public.start_test_attempt(text)'::regprocedure)) = 0
    or position('ATTEMPT_DAILY_LIMIT' in
      pg_get_functiondef('private.rpc_error_envelope(text,text,text)'::regprocedure)) = 0
    or position('ATTEMPT_ROLLING_LIMIT' in
      pg_get_functiondef('private.rpc_error_envelope(text,text,text)'::regprocedure)) = 0
    or position('jsonb_object_keys' in
      pg_get_functiondef('private.rpc_error_envelope(text,text,text)'::regprocedure)) = 0
    or position('target_user_id' in
      pg_get_functiondef(
        'public.claim_auth_admin_operation_confirmed(uuid,text,uuid,text,text,text)'::regprocedure
      )) = 0
    or position('safetyhub.purge_operation_ids' in
      pg_get_functiondef('public.purge_user_account(uuid)'::regprocedure)) = 0
    or position('safetyhub.purge_operation_ids' in
      pg_get_functiondef('private.guard_admin_audit_log()'::regprocedure)) = 0
    or position('safetyhub.purge_correlation_ids' in
      pg_get_functiondef('private.guard_admin_audit_log()'::regprocedure)) > 0
    or position('audit.correlation_id = any' in
      pg_get_functiondef('public.purge_user_account(uuid)'::regprocedure)) > 0 then
    raise exception 'daily-limit detail, legacy error compatibility, or purge-linked audit hardening missing';
  end if;

  if position('private.require_active_user()' in
      pg_get_functiondef('public.get_user_identity(uuid)'::regprocedure)) = 0
    or position('private.require_active_user()' in
      pg_get_functiondef(
        'public.search_profile_organizations(text,integer)'::regprocedure
      )) = 0 then
    raise exception 'active-account read-model guard missing';
  end if;

  if position('private.lock_active_superadmin_invariant(' in
      pg_get_functiondef(
        'public.advance_auth_admin_operation(uuid,text,text,uuid,text)'::regprocedure
      )) = 0
    or position('safetyhub:superadmin-role' in
      pg_get_functiondef('public.bootstrap_superadmin(uuid)'::regprocedure)) = 0
    or position('safetyhub:superadmin-role' in
      pg_get_functiondef('public.provision_admin_by_email(text)'::regprocedure)) = 0
    or position('private.lock_active_superadmin_invariant()' in
      pg_get_functiondef('public.begin_user_account_purge(uuid)'::regprocedure)) = 0
    or position('private.lock_active_superadmin_invariant()' in
      pg_get_functiondef('public.purge_user_account(uuid)'::regprocedure)) = 0
    or position('private.lock_active_superadmin_invariant()' in
      pg_get_functiondef(
        'public.manage_user_role_confirmed(uuid,public.app_role,text,uuid,text,text,text)'::regprocedure
      )) = 0 then
    raise exception 'active superadmin transition lock missing';
  end if;

  if public.get_capacity_metrics() -> 'relations' is null
    or not (public.get_capacity_metrics() ? 'databaseBytes') then
    raise exception 'capacity metrics contract invalid';
  end if;

  if (select count(*) from public.site_settings) <> 1 then
    raise exception 'site settings singleton count invalid';
  end if;
  if (select phone_e164 from public.site_settings) <> '+77017290349'
    or (select whatsapp_e164 from public.site_settings) <> '+77017290349' then
    raise exception 'site contact fallback seed invalid';
  end if;

  if (select count(*) from public.legal_document_versions where is_current) <> 2
    or not exists (select 1 from public.legal_document_versions
      where document_type = 'privacy' and version = '1.1' and body_revision = 'privacy-1.1'
        and not is_current)
    or not exists (select 1 from public.legal_document_versions
      where document_type = 'terms' and version = '2.1' and body_revision = 'terms-2.1'
        and not is_current)
    or not exists (select 1 from public.legal_document_versions
      where document_type = 'privacy' and version = '1.2' and body_revision = 'privacy-1.2'
        and is_current)
    or not exists (select 1 from public.legal_document_versions
      where document_type = 'terms' and version = '2.2' and body_revision = 'terms-2.2'
        and is_current) then
    raise exception 'current legal versions invalid';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.legal_document_versions'::regclass
      and tgname = 'legal_document_versions_immutable'
      and not tgisinternal
  ) then
    raise exception 'legal immutability trigger missing';
  end if;

  perform public.publish_legal_document_version(
    'privacy', '1.3-test', 'privacy-1.3-test', statement_timestamp()
  );
  if not exists (
    select 1 from public.legal_document_versions
    where document_type = 'privacy' and version = '1.3-test' and is_current
  ) or exists (
    select 1 from public.legal_document_versions
    where document_type = 'privacy' and version = '1.2' and is_current
  ) then
    raise exception 'controlled legal version rotation failed';
  end if;

  if to_regprocedure('public.list_admin_attempts_page(integer,text,public.attempt_status,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)') is not null
    or to_regprocedure('public.list_admin_certificates_page(integer,text,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)') is not null
    or to_regprocedure('public.request_user_deletion_confirmed(uuid,text,uuid,text,text,text)') is not null
    or to_regprocedure('public.mark_signup_legal_acceptance(uuid,text,text)') is not null
    or to_regprocedure('public.mark_profile_avatar_uploaded(uuid,timestamp with time zone)') is not null then
    raise exception 'legacy split admin/deletion RPC survived';
  end if;
end;
$test$;

rollback;
