begin;

do $test$
declare
  v_public_routine text;
begin
  if exists (
    select 1 from public.admin_capability_catalog
    where capability = 'user.mfa_reset' or capability like '%mfa%'
  ) then
    raise exception 'MFA capability survived baseline';
  end if;

  if not exists (
    select 1 from public.admin_capability_catalog
    where capability = 'site.settings.manage' and admin_default
  ) then
    raise exception 'admin site.settings.manage default is missing';
  end if;

  if has_function_privilege('anon', 'public.purge_user_account(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.purge_user_account(uuid)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.begin_user_account_purge(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.get_capacity_metrics()', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.get_capacity_metrics()', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.publish_legal_document_version(public.legal_document_type,text,text,timestamp with time zone)', 'EXECUTE') then
    raise exception 'service-only function leaked to browser roles';
  end if;

  if not has_function_privilege('service_role', 'public.purge_user_account(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.begin_user_account_purge(uuid)', 'EXECUTE')
    or not has_function_privilege('service_role', 'public.get_capacity_metrics()', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.publish_legal_document_version(public.legal_document_type,text,text,timestamp with time zone)', 'EXECUTE') then
    raise exception 'service-only function lacks service_role grant';
  end if;

  if has_function_privilege(
      'anon', 'public.publish_legal_document_bundle(text,text)', 'EXECUTE'
    )
    or not has_function_privilege(
      'authenticated', 'public.publish_legal_document_bundle(text,text)', 'EXECUTE'
    )
    or has_function_privilege(
      'service_role', 'public.publish_legal_document_bundle(text,text)', 'EXECUTE'
    ) then
    raise exception 'legal bundle publisher grant boundary is invalid';
  end if;

  if to_regprocedure('public.mark_profile_avatar_uploaded(uuid,timestamptz)') is not null
    or to_regprocedure('public.mark_signup_legal_acceptance(uuid,text,text)') is not null
    or exists (
      select 1
      from pg_trigger
      where tgrelid = 'auth.users'::regclass
        and tgname = 'on_auth_user_record_legal_acceptance'
        and not tgisinternal
    ) then
    raise exception 'legacy signup/avatar mutation boundary survived';
  end if;

  if has_function_privilege('anon',
      'public.consume_business_quota(text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'public.consume_business_quota(text)', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.consume_business_quota(text)', 'EXECUTE') then
    raise exception 'caller-selected raw actor quota function is executable';
  end if;

  if exists (
    select 1
    from (values
      ('public.consume_business_quota_for_actor(uuid,text)'::regprocedure),
      ('public.consume_coarse_ip_quota(text,text)'::regprocedure),
      ('public.prune_coarse_ip_rate_limits(integer)'::regprocedure),
      ('public.prepare_signup_legal_operation(uuid,text,text,text,text,text,text)'::regprocedure),
      ('public.finalize_signup_legal_operation(uuid,uuid,text)'::regprocedure),
      ('public.prune_signup_legal_operations(integer)'::regprocedure),
      ('public.get_profile_avatar_manifest(uuid)'::regprocedure),
      ('public.begin_profile_avatar_upload(uuid,text,integer)'::regprocedure),
      ('public.finish_profile_avatar_storage_write(uuid,uuid,text)'::regprocedure),
      ('public.mark_profile_avatar_staged(uuid,uuid,text,integer)'::regprocedure),
      ('public.finalize_profile_avatar_upload(uuid,uuid)'::regprocedure),
      ('public.abort_profile_avatar_upload(uuid,uuid,text)'::regprocedure),
      ('public.get_profile_avatar_upload_operation(uuid,uuid)'::regprocedure),
      ('public.claim_profile_avatar_reconciliation(uuid,integer)'::regprocedure),
      ('public.complete_profile_avatar_reconciliation(uuid,uuid,text,text)'::regprocedure),
      ('public.prune_terminal_avatar_upload_operations(integer)'::regprocedure),
      ('public.claim_account_storage_cleanup(uuid,integer)'::regprocedure),
      ('public.advance_account_storage_cleanup(uuid,uuid,text,text)'::regprocedure),
      ('public.prune_account_storage_cleanup_tombstones(integer)'::regprocedure),
      ('public.advance_auth_admin_operation(uuid,text,text,uuid,text)'::regprocedure),
      ('public.prune_terminal_auth_admin_outbox(integer)'::regprocedure)
    ) required(routine)
    where has_function_privilege('anon', required.routine, 'EXECUTE')
      or has_function_privilege('authenticated', required.routine, 'EXECUTE')
      or not has_function_privilege('service_role', required.routine, 'EXECUTE')
  ) then
    raise exception 'service-only reconciliation/signup/quota function ACL invalid';
  end if;

  if has_function_privilege('anon',
      'public.profile_avatar_object_is_committed(text)', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.profile_avatar_object_is_committed(text)', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.profile_avatar_object_is_committed(text)', 'EXECUTE')
    or has_function_privilege('anon',
      'public.get_my_profile_avatar_manifest()', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.get_my_profile_avatar_manifest()', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.get_my_profile_avatar_manifest()', 'EXECUTE') then
    raise exception 'owner-only avatar read helper ACL invalid';
  end if;

  if has_function_privilege('anon', 'public.get_admin_attestation_filters()', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.get_admin_attestation_filters()', 'EXECUTE')
    or not has_function_privilege('service_role',
      'public.get_admin_attestation_filters()', 'EXECUTE') then
    raise exception 'admin attestation filter privilege boundary invalid';
  end if;

  if has_function_privilege('authenticated',
      'public.get_profile_attestations()', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.get_profile_attestations()', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.get_user_identity(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.search_profile_organizations(text,integer)', 'EXECUTE') then
    raise exception 'active-account read-model privilege boundary invalid';
  end if;

  if has_function_privilege('anon', 'private.normalize_profile_text(text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.normalize_profile_text(text)', 'EXECUTE')
    or has_function_privilege('anon', 'private.normalized_lookup_key(text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.normalized_lookup_key(text)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'private.normalize_profile_text(text)', 'EXECUTE')
    or not has_function_privilege('service_role',
      'private.normalized_lookup_key(text)', 'EXECUTE') then
    raise exception 'profile normalizer maintenance grants invalid';
  end if;

  if has_schema_privilege('anon', 'private', 'USAGE')
    or has_schema_privilege('authenticated', 'private', 'USAGE')
    or not has_schema_privilege('service_role', 'private', 'USAGE') then
    raise exception 'private schema maintenance usage boundary invalid';
  end if;

  if has_function_privilege('anon',
      'private.rpc_error_envelope(text,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.rpc_error_envelope(text,text,text)', 'EXECUTE')
    or has_function_privilege('service_role',
      'private.rpc_error_envelope(text,text,text)', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.ensure_rpc_payload(jsonb)', 'EXECUTE') then
    raise exception 'private RPC envelope helper leaked';
  end if;

  if exists (
    select 1
    from pg_proc routine
    join pg_namespace namespace on namespace.oid = routine.pronamespace
    where namespace.nspname = 'private'
      and has_function_privilege('service_role', routine.oid, 'EXECUTE')
      and routine.oid not in (
        'private.normalize_profile_text(text)'::regprocedure::oid,
        'private.normalized_lookup_key(text)'::regprocedure::oid
      )
  ) then
    raise exception 'service role has unexpected private function execute';
  end if;

  if has_table_privilege('anon', 'public.site_settings', 'SELECT')
    or has_table_privilege('authenticated', 'public.site_settings', 'SELECT') then
    raise exception 'site settings actor metadata is directly readable';
  end if;

  if has_table_privilege('authenticated', 'public.profiles', 'SELECT')
    or has_table_privilege('authenticated', 'public.user_roles', 'SELECT')
    or has_table_privilege('authenticated', 'public.account_controls', 'SELECT')
    or has_table_privilege('authenticated', 'public.verified_identities', 'SELECT')
    or has_table_privilege('authenticated', 'public.test_attempts', 'SELECT')
    or has_table_privilege('authenticated', 'public.attestations', 'SELECT')
    or has_table_privilege('authenticated', 'public.certificates', 'SELECT')
    or has_table_privilege('authenticated', 'public.admin_audit_log', 'SELECT') then
    raise exception 'sensitive table bypass is directly readable';
  end if;

  if has_column_privilege('anon', 'public.tests', 'draft_content', 'SELECT')
    or has_column_privilege('authenticated', 'public.tests', 'draft_content', 'SELECT')
    or has_column_privilege('anon', 'public.tests', 'created_by', 'SELECT')
    or has_column_privilege('authenticated', 'public.tests', 'updated_by', 'SELECT')
    or has_column_privilege('anon', 'public.tests', 'slug', 'SELECT')
    or has_column_privilege('authenticated', 'public.tests', 'title', 'SELECT')
    or not has_column_privilege('anon', 'public.tests', 'id', 'SELECT')
    or not has_column_privilege('authenticated', 'public.tests', 'current_revision_id', 'SELECT')
    or not has_column_privilege('authenticated', 'public.tests', 'status', 'SELECT') then
    raise exception 'published test column privilege boundary invalid';
  end if;

  if has_column_privilege('anon', 'public.articles', 'created_by', 'SELECT')
    or has_column_privilege('authenticated', 'public.articles', 'updated_by', 'SELECT')
    or not has_column_privilege('anon', 'public.articles', 'seo', 'SELECT')
    or not has_column_privilege('authenticated', 'public.articles', 'seo', 'SELECT')
    or has_column_privilege('anon', 'public.test_revisions', 'published_by', 'SELECT')
    or has_column_privilege('authenticated', 'public.test_revisions', 'published_by', 'SELECT') then
    raise exception 'public content actor metadata is directly readable';
  end if;

  if has_table_privilege('authenticated', 'private.test_revision_answer_keys', 'SELECT')
    or has_table_privilege('service_role', 'private.test_revision_answer_keys', 'SELECT') then
    raise exception 'private answer key table is directly readable';
  end if;

  if exists (
    select 1
    from (values
      ('private.signup_legal_operations'::regclass),
      ('private.profile_avatar_manifests'::regclass),
      ('private.avatar_upload_operations'::regclass),
      ('private.account_storage_cleanup_tombstones'::regclass),
      ('private.auth_admin_outbox'::regclass),
      ('private.business_rate_limits'::regclass),
      ('private.coarse_ip_rate_limits'::regclass)
    ) sensitive(relation)
    where has_table_privilege('anon', sensitive.relation, 'SELECT')
      or has_table_privilege('authenticated', sensitive.relation, 'SELECT')
      or has_table_privilege('service_role', sensitive.relation, 'SELECT')
  ) then
    raise exception 'private operation/quota state is directly readable';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'profile_avatars_select_own'
  ) then
    raise exception 'avatar owner read policy is missing';
  end if;

  if has_function_privilege('anon',
      'public.profile_avatar_storage_write_is_authorized(text)', 'EXECUTE')
    or not has_function_privilege('authenticated',
      'public.profile_avatar_storage_write_is_authorized(text)', 'EXECUTE')
    or has_function_privilege('service_role',
      'public.profile_avatar_storage_write_is_authorized(text)', 'EXECUTE') then
    raise exception 'avatar Storage write authorization ACL invalid';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'profile_avatars_insert_live_operation'
      and cmd = 'INSERT'
      and roles @> array['authenticated']::name[]
      and coalesce(with_check, '') like '%profile-avatars%'
      and coalesce(with_check, '') like
        '%profile_avatar_storage_write_is_authorized%'
  ) then
    raise exception 'bounded avatar staging INSERT policy is missing';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'storage.objects'::regclass
      and tgname = 'profile_avatar_storage_write_guard'
      and not tgisinternal
  ) or has_function_privilege('anon',
      'private.guard_profile_avatar_storage_write()', 'EXECUTE')
    or has_function_privilege('authenticated',
      'private.guard_profile_avatar_storage_write()', 'EXECUTE')
    or has_function_privilege('service_role',
      'private.guard_profile_avatar_storage_write()', 'EXECUTE') then
    raise exception 'final avatar Storage metadata guard boundary invalid';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname <> 'profile_avatars_insert_live_operation'
      and cmd = 'INSERT'
      and roles @> array['authenticated']::name[]
      and coalesce(with_check, '') like '%profile-avatars%'
  ) then
    raise exception 'unexpected browser avatar INSERT policy survived';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and cmd in ('UPDATE', 'DELETE')
      and roles @> array['authenticated']::name[]
      and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
        like '%profile-avatars%'
  ) then
    raise exception 'browser avatar overwrite/delete policy survived';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.attestations'::regclass
      and tgname = 'attestations_best_attempt_guard' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.admin_audit_log'::regclass
      and tgname = 'admin_audit_log_immutable' and not tgisinternal
  ) then
    raise exception 'attestation or audit integrity trigger missing';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'auth_users_avatar_cleanup_guard'
      and not tgisinternal
  ) then
    raise exception 'Auth deletion Storage cleanup guard missing';
  end if;

  if (select count(*) from pg_trigger
      where tgrelid = 'public.user_roles'::regclass
        and tgname in (
          'user_roles_active_superadmin_before',
          'user_roles_active_superadmin_after'
        )
        and not tgisinternal) <> 2
    or (select count(*) from pg_trigger
      where tgrelid = 'public.account_controls'::regclass
        and tgname in (
          'account_controls_active_superadmin_before',
          'account_controls_active_superadmin_after'
        )
        and not tgisinternal) <> 2 then
    raise exception 'active superadmin invariant triggers missing';
  end if;
end;
$test$;

rollback;
