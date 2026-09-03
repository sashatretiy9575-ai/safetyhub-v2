begin;

do $test$
declare
  v_relation text;
  v_start_definition text;
  v_payload_definition text;
  v_complete_definition text;
  v_activation_definition text;
  v_history_definition text;
  v_history_preview_definition text;
  v_history_targets_definition text;
  v_hash_definition text;
  v_cleanup_definition text;
  v_snapshot_definition text;
  v_presentation_guard_definition text;
  v_maintenance_definition text;
  v_legacy_guard_definition text;
  v_status_definition text;
  v_finalize_definition text;
  v_retire_definition text;
  v_approval_gate_definition text;
begin
  foreach v_relation in array array[
    'public.course_presentations',
    'public.test_revision_variants',
    'public.course_catalog_batches',
    'public.course_catalog_batch_items'
  ] loop
    if to_regclass(v_relation) is null then
      raise exception 'course catalogue v3 relation missing: %', v_relation;
    end if;
    if not exists (
      select 1 from pg_class relation
      where relation.oid = to_regclass(v_relation) and relation.relrowsecurity
    ) then
      raise exception 'course catalogue v3 RLS disabled: %', v_relation;
    end if;
  end loop;

  if to_regclass('private.test_revision_variant_answer_keys') is null
    or to_regclass('private.learning_history_delete_receipts') is null then
    raise exception 'private course catalogue relation missing';
  end if;

  if to_regprocedure(
      'public.save_course_draft_v3(uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb)'
    ) is null
    or to_regprocedure(
      'public.save_and_publish_course_v3(uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb)'
    ) is null
    or to_regprocedure('public.publish_course_revision_v3(uuid,uuid,text)') is null
    or to_regprocedure('public.get_course_editor_payload_v3(uuid,uuid)') is null
    or to_regprocedure('public.get_admin_learning_history(uuid,uuid)') is null
    or to_regprocedure(
      'public.list_learning_history_targets_page(uuid,integer,text,timestamp with time zone,uuid)'
    ) is null
    or to_regprocedure('public.delete_admin_learning_history(uuid,uuid,text,uuid)') is null
    or to_regprocedure('public.prepare_course_catalog_batch(uuid,uuid[])') is null
    or to_regprocedure('public.activate_course_catalog_batch(uuid,uuid,uuid)') is null
    or to_regprocedure(
      'public.claim_stale_course_presentations(integer,integer,integer)'
    ) is null
    or to_regprocedure(
      'public.complete_course_presentation_cleanup(uuid[])'
    ) is null
    or to_regprocedure(
      'public.get_published_course_snapshot_v3(uuid)'
    ) is null
    or to_regprocedure(
      'public.get_course_catalog_maintenance(uuid)'
    ) is null
    or to_regprocedure(
      'public.set_course_catalog_maintenance(uuid,boolean)'
    ) is null
    or to_regprocedure(
      'public.finalize_course_presentation_metadata(uuid,uuid,uuid,text,integer,bigint,text,text)'
    ) is null
    or to_regprocedure(
      'public.retire_course_presentation(uuid,uuid,uuid)'
    ) is null then
    raise exception 'course catalogue v3 RPC contract missing';
  end if;

  if not has_function_privilege(
      'authenticated',
      'public.save_course_draft_v3(uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb)',
      'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.get_course_editor_payload_v3(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.get_course_editor_payload_v3(uuid,uuid)', 'execute'
    )
    -- The narrow audited replacement is the only editor read that is granted,
    -- and it stays away from anon and service_role.
    or not has_function_privilege(
      'authenticated', 'public.read_course_question_bank_v4(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'anon', 'public.read_course_question_bank_v4(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'service_role', 'public.read_course_question_bank_v4(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.get_test_editor_payload(uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.get_test_editor_payload_v2(uuid,uuid)', 'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.delete_admin_learning_history(uuid,uuid,text,uuid)', 'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.list_learning_history_targets_page(uuid,integer,text,timestamp with time zone,uuid)',
      'execute'
    )
    or has_function_privilege(
      'anon',
      'public.list_learning_history_targets_page(uuid,integer,text,timestamp with time zone,uuid)',
      'execute'
    )
    or has_function_privilege(
      'anon', 'public.delete_admin_learning_history(uuid,uuid,text,uuid)', 'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.claim_stale_course_presentations(integer,integer,integer)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.claim_stale_course_presentations(integer,integer,integer)',
      'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.get_published_course_snapshot_v3(uuid)', 'execute'
    )
    or not has_function_privilege(
      'service_role', 'public.get_published_course_snapshot_v3(uuid)', 'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.set_course_catalog_maintenance(uuid,boolean)', 'execute'
    )
    or has_function_privilege(
      'anon', 'public.set_course_catalog_maintenance(uuid,boolean)', 'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.finalize_course_presentation_metadata(uuid,uuid,uuid,text,integer,bigint,text,text)',
      'execute'
    )
    or has_function_privilege(
      'authenticated',
      'public.finalize_course_presentation_metadata(uuid,uuid,uuid,text,integer,bigint,text,text)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.retire_course_presentation(uuid,uuid,uuid)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'public.change_course_slug(uuid,uuid,bigint,text)', 'execute'
    ) then
    raise exception 'course catalogue v3 execute grants invalid';
  end if;

  if not exists (
    select 1 from public.admin_capability_catalog
    where capability = 'results.delete' and admin_default and sensitive
  ) then
    raise exception 'results.delete capability missing';
  end if;

  if has_table_privilege('anon', 'public.tests', 'select')
    or has_table_privilege('authenticated', 'public.test_revisions', 'select')
    or has_table_privilege('authenticated', 'public.test_revision_variants', 'select')
    or has_table_privilege(
      'authenticated', 'private.test_revision_variant_answer_keys', 'select'
    )
    or has_table_privilege(
      'service_role', 'private.test_revision_variant_answer_keys', 'select'
    )
    or has_column_privilege(
      'authenticated', 'public.test_attempts', 'variant_id', 'select'
    )
    or has_column_privilege(
      'authenticated', 'public.test_revisions', 'questions', 'select'
    )
    or has_column_privilege(
      'anon', 'public.tests', 'draft_content', 'select'
    )
    or has_column_privilege(
      'anon', 'public.tests', 'content_hash', 'select'
    )
    or has_table_privilege('authenticated', 'public.test_attempts', 'insert')
    or has_table_privilege('authenticated', 'public.test_attempts', 'update')
    or has_table_privilege('authenticated', 'public.test_attempts', 'delete')
    or not has_column_privilege(
      'anon', 'public.tests', 'status', 'select'
    ) then
    raise exception 'course draft, variant, or answer-key direct surface is unsafe';
  end if;

  if has_column_privilege(
      'anon', 'public.course_presentations', 'storage_path', 'select'
    )
    or has_column_privilege(
      'authenticated', 'public.course_presentations', 'storage_path', 'select'
    )
    or has_column_privilege(
      'anon', 'public.course_presentations', 'thumbnail_path', 'select'
    )
    or has_column_privilege(
      'authenticated', 'public.course_presentations', 'source_filename', 'select'
    )
    or not has_column_privilege(
      'anon', 'public.course_presentations', 'page_count', 'select'
    )
    or not has_table_privilege(
      'service_role', 'public.course_presentations', 'insert'
    ) then
    raise exception 'presentation metadata grants invalid';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'course_presentations'
      and policyname = 'course_presentations_catalog_read'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'course_presentations_staging_admin_read'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'course_presentations_browser_access_denied'
      and permissive = 'RESTRICTIVE'
  ) or exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'course_presentations_staging_admin_insert'
  ) then
    raise exception 'presentation RLS or signed-upload-only boundary invalid';
  end if;

  if to_regprocedure('private.require_approved_learner()') is null
    or to_regprocedure('public.get_approved_course_presentation(text,text)') is null
    or has_function_privilege('anon', 'public.get_approved_course_presentation(text,text)', 'execute')
    or not has_function_privilege(
      'authenticated', 'public.get_approved_course_presentation(text,text)', 'execute'
    )
    or has_function_privilege(
      'authenticated', 'private.require_approved_learner()', 'execute'
    )
    or (select public from storage.buckets where id = 'course-presentations') is distinct from false then
    raise exception 'approval-gated private presentation access contract invalid';
  end if;

  select pg_get_functiondef('private.require_approved_learner()'::regprocedure)
  into v_approval_gate_definition;
  if position('control.status = ''active''' in v_approval_gate_definition) = 0
    or position('not control.deletion_pending' in v_approval_gate_definition) = 0
    or position('for share' in lower(v_approval_gate_definition)) = 0
    or position('ACCOUNT_APPROVAL_REQUIRED' in v_approval_gate_definition) = 0 then
    raise exception 'approved learner gate must lock and recheck active/deletion state';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_attempts'
      and column_name = 'variant_id' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_attempts'
      and column_name = 'test_id' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'course_drafts'
      and column_name = 'question_variants'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_revision_variants'
      and column_name = 'stable_id' and is_nullable = 'NO'
  ) then
    raise exception 'course catalogue v3 column contract missing';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_revisions'
      and column_name = 'attempts_per_calendar_day'
      and column_default = '8'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_revisions'
      and column_name = 'attempt_reset_timezone'
      and column_default = '''Asia/Oral''::text'
  ) or coalesce(position(
    'attempt_reset_timezone = ''Asia/Oral''::text'
    in pg_get_constraintdef(
      (select oid from pg_constraint
       where conname = 'revision_attempt_reset_timezone'
         and conrelid = 'public.test_revisions'::regclass)
    )
  ), 0) = 0 then
    raise exception 'course revision daily-attempt policy defaults invalid';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_revision_variants'
      and column_name = 'question_count' and column_default = '10'
  ) or not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.course_presentations'::regclass
      and conname = 'course_presentation_ready_immutable_path'
      and pg_get_constraintdef(oid) like '%storage_path%course_id%sha256%'
  ) then
    raise exception 'variant defaults or immutable presentation path contract missing';
  end if;

  if private.jsonb_canonical_text(
      '{"z":1,"a":[{"b":2,"a":1},null],"aa":"v"}'::jsonb
    ) <> '{"a":[{"a":1,"b":2},null],"aa":"v","z":1}' then
    raise exception 'canonical content-hash JSON serialization drifted';
  end if;
  v_hash_definition := lower(pg_get_functiondef(
    'private.course_content_hash_v3(text,text,text,text,integer,text,integer,integer,integer,integer,text,jsonb,jsonb,text,date,jsonb)'::regprocedure
  ));
  if position('private.jsonb_canonical_text' in v_hash_definition) = 0 then
    raise exception 'course v3 content hash is not snapshot-reproducible';
  end if;

  v_snapshot_definition := lower(pg_get_functiondef(
    'public.get_published_course_snapshot_v3(uuid)'::regprocedure
  ));
  if position('private.reconstruct_course_question_variants' in v_snapshot_definition) = 0
    or position('catalog_snapshot_hash_mismatch' in v_snapshot_definition) = 0
    or position('''id'', variant.stable_id' in lower(pg_get_functiondef(
      'private.reconstruct_course_question_variants(uuid)'::regprocedure
    ))) = 0 then
    raise exception 'published revision is not losslessly snapshot-reconstructible';
  end if;

  v_cleanup_definition := lower(pg_get_functiondef(
    'public.claim_stale_course_presentations(integer,integer,integer)'::regprocedure
  ));
  if position('for update skip locked' in v_cleanup_definition) = 0
    or position('course-presentations-staging' in v_cleanup_definition) = 0
    or position('storage.objects' in v_cleanup_definition) > 0 then
    raise exception 'staging cleanup lease contract invalid';
  end if;

  v_maintenance_definition := lower(pg_get_functiondef(
    'public.set_course_catalog_maintenance(uuid,boolean)'::regprocedure
  ));
  if position('pg_advisory_xact_lock' in v_maintenance_definition) = 0
    or position('catalog.maintenance_enabled' in v_maintenance_definition) = 0
    or not exists (
      select 1 from pg_trigger
      where tgname = 'tests_course_catalog_maintenance' and not tgisinternal
    )
    or not exists (
      select 1 from pg_trigger
      where tgname = 'course_presentations_maintenance' and not tgisinternal
    ) then
    raise exception 'catalogue maintenance transition/guard contract invalid';
  end if;
  if position('course_catalog_maintenance_enabled' in lower(pg_get_functiondef(
      'private.save_course_draft_v3_unmetered(uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb)'::regprocedure
    ))) = 0
    or position('course_catalog_maintenance_enabled' in lower(pg_get_functiondef(
      'private.publish_course_revision_v3_unmetered(uuid,uuid,text)'::regprocedure
    ))) = 0
    or position('course_catalog_maintenance_enabled' in lower(pg_get_functiondef(
      'public.prepare_course_catalog_batch(uuid,uuid[])'::regprocedure
    ))) = 0 then
    raise exception 'save/publish/batch preparation maintenance checks missing';
  end if;
  v_legacy_guard_definition := lower(pg_get_functiondef(
    'public.save_course_draft_v2(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)'::regprocedure
  ));
  v_status_definition := lower(pg_get_functiondef(
    'public.set_test_status(uuid,uuid,public.test_status)'::regprocedure
  ));
  if position('assert_legacy_course_mutation_allowed' in v_legacy_guard_definition) = 0
    or position('course_editor_version_retired' in lower(pg_get_functiondef(
      'private.assert_legacy_course_mutation_allowed()'::regprocedure
    ))) = 0
    or position('publish_course_revision_v3_unmetered' in v_status_definition) = 0
    or position('course_catalog_v3_active' in v_status_definition) = 0 then
    raise exception 'post-activation legacy course mutation guard missing';
  end if;

  v_finalize_definition := lower(pg_get_functiondef(
    'public.finalize_course_presentation_metadata(uuid,uuid,uuid,text,integer,bigint,text,text)'::regprocedure
  ));
  if position('for update' in v_finalize_definition) = 0
    or position('course-presentations-staging' in v_finalize_definition) = 0
    or position('course-presentations' in v_finalize_definition) = 0
    or position('cleanup_claimed_at' in v_finalize_definition) = 0
    or position('insert into public.course_presentations' in v_finalize_definition) = 0 then
    raise exception 'presentation finalize/cleanup receipt contract invalid';
  end if;

  v_retire_definition := lower(pg_get_functiondef(
    'public.retire_course_presentation(uuid,uuid,uuid)'::regprocedure
  ));
  if position('for update' in v_retire_definition) = 0
    or position('from public.course_drafts' in v_retire_definition) = 0
    or position('from public.test_revisions' in v_retire_definition) = 0
    or position('presentation_in_use' in v_retire_definition) = 0 then
    raise exception 'presentation retirement is not atomic with reference checks';
  end if;

  if exists (
    select 1 from public.test_revisions revision
    where not exists (
      select 1 from public.test_revision_variants variant
      where variant.revision_id = revision.id
    )
  ) then
    raise exception 'legacy revision variant backfill incomplete';
  end if;

  if exists (
    select 1 from public.test_attempts attempt
    join public.test_revisions revision on revision.id = attempt.revision_id
    join public.test_revision_variants variant on variant.id = attempt.variant_id
    where attempt.test_id <> revision.test_id
      or variant.revision_id <> attempt.revision_id
  ) then
    raise exception 'attempt course/revision/variant invariant broken';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'test_revision_variants_immutable' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgname = 'test_revision_variant_answer_keys_immutable' and not tgisinternal
  ) then
    raise exception 'variant immutability trigger missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'course_presentations_protect_object' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgname = 'tests_retire_presentations_before_delete' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgname = 'test_attempts_validate_v3' and not tgisinternal
  ) then
    raise exception 'presentation/attempt integrity trigger missing';
  end if;
  v_presentation_guard_definition := lower(pg_get_functiondef(
    'private.protect_course_presentation_object()'::regprocedure
  ));
  if position('new.course_id is distinct from old.course_id' in v_presentation_guard_definition) = 0
    or position('old.status = ''retired''' in v_presentation_guard_definition) = 0
    or position('safetyhub.content_delete' in v_presentation_guard_definition) = 0 then
    raise exception 'ready presentation ownership is mutable or cutover exception is broad';
  end if;

  v_start_definition := lower(pg_get_functiondef(
    'private.start_test_attempt_unmetered(text)'::regprocedure
  ));
  if position(
      'at time zone v_revision.attempt_reset_timezone' in v_start_definition
    ) = 0
    or position(
      'v_count >= v_revision.attempts_per_calendar_day' in v_start_definition
    ) = 0
    or position('attempt_daily_limit' in v_start_definition) = 0
    or position('order by random()' in v_start_definition) = 0
    or position('test_id = v_test.id' in v_start_definition) = 0
    or position('pg_advisory_xact_lock' in v_start_definition) = 0
    or position('pg_advisory_xact_lock_shared' in v_start_definition) = 0 then
    raise exception 'calendar-day randomized attempt start invariants missing';
  end if;

  v_payload_definition := lower(pg_get_functiondef(
    'private.attempt_payload(uuid,timestamp with time zone)'::regprocedure
  ));
  if position('variantnumber' in v_payload_definition) > 0
    or position('''variantid''' in v_payload_definition) > 0
    or position('correctoptionid' in v_payload_definition) > 0
    or position('test_revision_variant_answer_keys' in v_payload_definition) > 0
    or position('''review''' in v_payload_definition) > 0
    or position('''passscore''' in v_payload_definition) = 0
    or position('''courseid''' in v_payload_definition) = 0
    or position('''revisionid''' in v_payload_definition) = 0
    or position('''startedat''' in v_payload_definition) = 0 then
    raise exception 'learner attempt payload exposes answer/variant key data or omits policy';
  end if;

  v_complete_definition := lower(pg_get_functiondef(
    'private.complete_test_attempt_unmetered(uuid,jsonb)'::regprocedure
  ));
  if position('v_attempt.status <> ''passed''' in v_complete_definition) = 0
    or position('insert into public.attestations' in v_complete_definition) = 0
    or position('v_attempt.status <> ''passed''' in v_complete_definition)
      > position('insert into public.attestations' in v_complete_definition)
    or position('jsonb_array_elements(v_variant.questions)' in v_complete_definition) = 0
    or position('invalid_attempt_question' in v_complete_definition) = 0
    or position('invalid_attempt_option' in v_complete_definition) = 0
    or position('v_key.correct_option_ids' in v_complete_definition) = 0 then
    raise exception 'attempt grading/variant-tamper boundary invalid';
  end if;

  v_history_definition := lower(pg_get_functiondef(
    'private.delete_admin_learning_history_unmetered(uuid,uuid,text,uuid)'::regprocedure
  ));
  if position('delete from private.certificate_export_jobs' in v_history_definition) = 0
    or position('delete from public.certificates' in v_history_definition) = 0
    or position('delete from public.attestations' in v_history_definition) = 0
    or position('delete from public.test_attempts' in v_history_definition) = 0
    or position('delete from public.profiles' in v_history_definition) > 0
    or position('delete from auth.users' in v_history_definition) > 0
    or position('learning_history_already_deleted' in v_history_definition) = 0 then
    raise exception 'learning-history deletion boundary invalid';
  end if;
  v_history_preview_definition := lower(pg_get_functiondef(
    'public.get_admin_learning_history(uuid,uuid)'::regprocedure
  )) || lower(pg_get_functiondef(
    'private.get_admin_learning_history_provider_internal(uuid,uuid)'::regprocedure
  ));
  if position('require_capability(''results.delete'')'
      in v_history_preview_definition) = 0
    or position('learning_history_target_not_allowed'
      in v_history_preview_definition) = 0
    or position('v_role is distinct from ''participant'''
      in v_history_preview_definition) = 0 then
    raise exception 'learning-history preview capability/target boundary invalid';
  end if;
  v_history_targets_definition := lower(pg_get_functiondef(
    'public.list_learning_history_targets_page(uuid,integer,text,timestamp with time zone,uuid)'::regprocedure
  )) || lower(pg_get_functiondef(
    'private.list_learning_history_targets_page_provider_internal(uuid,integer,text,timestamp with time zone,uuid)'::regprocedure
  ));
  if position('require_capability(''results.delete'')'
      in v_history_targets_definition) = 0
    or position('role.product_role = ''participant'''
      in v_history_targets_definition) = 0
    or position('private.capabilities_for_user' in v_history_targets_definition) > 0
    or position('verified_identities' in v_history_targets_definition) > 0
    or position('public.test_attempts' in v_history_targets_definition) > 0 then
    raise exception 'learning-history target list is broad or wrongly authorized';
  end if;

  v_activation_definition := lower(pg_get_functiondef(
    'private.activate_course_catalog_batch_unmetered(uuid,uuid,uuid)'::regprocedure
  ));
  if position('set status = ''retired''' in v_activation_definition) = 0
    or position('delete from public.tests' in v_activation_definition) = 0
    or position('set status = ''retired''' in v_activation_definition)
      > position('delete from public.tests' in v_activation_definition)
    or position('catalog_account_preservation_failed' in v_activation_definition) = 0
    or position('catalog_history_wipe_failed' in v_activation_definition) = 0 then
    raise exception 'atomic catalogue activation invariants missing';
  end if;
end;
$test$;

-- The static contract above makes privilege and definition drift easy to
-- diagnose. The fixtures below execute the security-sensitive state
-- transitions end-to-end against the disposable database used by CI.
create temporary table course_catalog_v3_fixture_namespace(id integer);

create function pg_temp.make_course_variants(p_label text)
returns jsonb
language plpgsql
as $$
declare
  v_variants jsonb := '[]'::jsonb;
  v_questions jsonb;
  v_options jsonb;
  v_variant jsonb;
  v_question jsonb;
  v_option jsonb;
  v_variant_id uuid;
  v_question_id uuid;
  v_option_id uuid;
  v_correct_option_id uuid;
  v_variant_number integer;
  v_question_number integer;
  v_option_number integer;
begin
  for v_variant_number in 1..3 loop
    v_variant_id := gen_random_uuid();
    v_questions := '[]'::jsonb;
    for v_question_number in 1..10 loop
      v_question_id := gen_random_uuid();
      v_options := '[]'::jsonb;
      for v_option_number in 1..4 loop
        v_option_id := gen_random_uuid();
        if v_option_number = 1 then
          v_correct_option_id := v_option_id;
        end if;
        v_option := jsonb_build_object(
          'id', v_option_id,
          'text', format('%s ответ %s.%s.%s', p_label, v_variant_number,
            v_question_number, v_option_number),
          'displayOrder', v_option_number
        );
        v_options := v_options || jsonb_build_array(v_option);
      end loop;
      v_question := jsonb_build_object(
        'id', v_question_id,
        'text', format('%s вопрос %s.%s', p_label, v_variant_number,
          v_question_number),
        'displayOrder', v_question_number,
        'options', v_options,
        'correctOptionId', v_correct_option_id,
        'explanation', ''
      );
      v_questions := v_questions || jsonb_build_array(v_question);
    end loop;
    v_variant := jsonb_build_object(
      'id', v_variant_id,
      'variantNumber', v_variant_number,
      'questions', v_questions
    );
    v_variants := v_variants || jsonb_build_array(v_variant);
  end loop;
  return v_variants;
end;
$$;

create function pg_temp.make_attempt_answers(
  p_variant_id uuid,
  p_correct_count integer
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'questionId', question.value ->> 'id',
    'optionId', case
      when question.ordinality <= p_correct_count
        then answer_key.correct_option_ids
          ->> (question.ordinality::integer - 1)
      else question.value -> 'options' -> 1 ->> 'id'
    end
  ) order by question.ordinality), '[]'::jsonb)
  from public.test_revision_variants variant
  join private.test_revision_variant_answer_keys answer_key
    on answer_key.variant_id = variant.id
    and answer_key.revision_id = variant.revision_id
  cross join lateral jsonb_array_elements(variant.questions)
    with ordinality question(value, ordinality)
  where variant.id = p_variant_id;
$$;

do $behavior$
declare
  v_admin_id constant uuid := '70000000-0000-4000-8000-000000000001';
  v_participant_a constant uuid := '70000000-0000-4000-8000-000000000002';
  v_participant_b constant uuid := '70000000-0000-4000-8000-000000000003';
  v_behavior_test_id constant uuid := '71000000-0000-4000-8000-000000000001';
  v_behavior_revision_id constant uuid := '71000000-0000-4000-8000-000000000002';
  v_old_presentation_id constant uuid := '71000000-0000-4000-8000-000000000003';
  v_history_key constant uuid := '72000000-0000-4000-8000-000000000001';
  v_empty_history_key constant uuid := '72000000-0000-4000-8000-000000000002';
  v_activation_key constant uuid := '72000000-0000-4000-8000-000000000003';
  v_variants jsonb;
  v_invalid_variants jsonb;
  v_variant jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_answers jsonb;
  v_tampered_answers jsonb;
  v_attempt_id uuid;
  v_resumed_attempt_id uuid;
  v_variant_id uuid;
  v_other_question_id text;
  v_attestation_id uuid;
  v_certificate_id uuid;
  v_export_job_id uuid;
  v_blocked boolean;
  v_retry_at timestamptz;
  v_index integer;
  v_course_id uuid;
  v_presentation_id uuid;
  v_cleanup_id uuid;
  v_unused_presentation_id uuid;
  v_upload_id uuid;
  v_draft_version bigint;
  v_sha256 text;
  v_staging_path text;
  v_thumbnail_path text;
  v_batch_id uuid;
  v_test_ids uuid[] := '{}'::uuid[];
  v_presentation_ids uuid[] := '{}'::uuid[];
  v_slugs text[] := array[
    'plotnik', 'armaturshchik', 'lesomontazhnye-raboty', 'biot',
    'pozharnaya-bezopasnost'
  ];
  v_titles text[] := array[
    'Плотник', 'Арматурщик', 'Лесомонтажные работы', 'БИОТ',
    'Пожарная безопасность'
  ];
  v_pages integer[] := array[25, 31, 42, 59, 41];
  v_auth_count integer;
  v_profile_count integer;
  v_article_count integer;
  v_snapshot jsonb;
begin
  -- Normalize any seed catalogue inside this rolled-back test transaction so
  -- the behavioral fixture is independent of whether CI loaded seed.sql.
  update private.course_catalog_runtime_state
  set maintenance_enabled = false, updated_by = null,
      updated_at = statement_timestamp()
  where singleton;
  perform set_config('safetyhub.catalog_activation', '1', true);
  perform set_config('safetyhub.content_delete', '1', true);
  delete from private.certificate_export_jobs;
  delete from public.certificates;
  delete from public.attestations;
  delete from public.test_attempts;
  delete from public.course_catalog_batches;
  update public.course_presentations
  set status = 'retired', retired_at = statement_timestamp(),
      cleanup_claimed_at = null
  where status = 'ready';
  delete from public.tests;
  perform set_config('safetyhub.catalog_activation', '', true);
  perform set_config('safetyhub.content_delete', '', true);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
  (
    '00000000-0000-0000-0000-000000000000', v_admin_id,
    'authenticated', 'authenticated', 'catalog-admin@safetyhub.invalid', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000', v_participant_a,
    'authenticated', 'authenticated', 'catalog-a@safetyhub.invalid', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  ),
  (
    '00000000-0000-0000-0000-000000000000', v_participant_b,
    'authenticated', 'authenticated', 'catalog-b@safetyhub.invalid', '',
    statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
    statement_timestamp(), statement_timestamp()
  );

  update public.user_roles set role = 'admin' where user_id = v_admin_id;
  update public.profiles
  set name = case id
        when v_participant_a then 'Участник'
        when v_participant_b then 'Лимит'
        else 'Администратор'
      end,
      surname = case id
        when v_participant_a then 'Истории'
        when v_participant_b then 'Календарный'
        else 'Каталога'
      end,
      job = 'Специалист', organization = 'SafetyHub',
      avatar_updated_at = statement_timestamp(),
      onboarding_completed_at = statement_timestamp()
  where id in (v_admin_id, v_participant_a, v_participant_b);

  update public.verified_identities
  set status = 'verified', version = 1,
      name = 'Участник', surname = 'Истории', job = 'Специалист',
      organization = 'SafetyHub', verified_at = statement_timestamp(),
      verified_by = v_admin_id
  where user_id = v_participant_a;

  insert into public.legal_acceptances(
    user_id, document_type, version, source
  )
  select participant.id, document.document_type, document.version, 'profile'
  from unnest(array[v_participant_a, v_participant_b]) participant(id)
  cross join public.legal_document_versions document
  where document.is_current
  on conflict do nothing;

  v_variants := pg_temp.make_course_variants('Поведенческий тест');
  if not private.course_question_variants_valid(v_variants) then
    raise exception 'valid 3x10x4 fixture rejected';
  end if;
  v_invalid_variants := jsonb_set(
    v_variants,
    '{0,questions,0,options,0,id}',
    to_jsonb(v_variants #>> '{0,id}'),
    false
  );
  if private.course_question_variants_valid(v_invalid_variants) then
    raise exception 'cross-entity duplicate UUID fixture unexpectedly accepted';
  end if;

  insert into public.tests(
    id, slug, title, description, icon, display_order, seo, draft_content,
    duration_minutes, pass_score, attempts_per_calendar_day,
    attempt_reset_timezone, status, content_hash, created_by, updated_by
  ) values (
    v_behavior_test_id, 'db-v3-behavior-fixture', 'DB v3 behavior fixture',
    '', 'factory', 900, '{}'::jsonb,
    jsonb_build_object('questions', '[]'::jsonb,
      'questionVariants', v_variants),
    15, 7, 8, 'Asia/Oral', 'draft', repeat('a', 64),
    v_admin_id, v_admin_id
  );
  insert into public.test_revisions(
    id, test_id, version, slug, title, description, icon, display_order,
    content, seo, content_hash, questions, question_count,
    duration_minutes, pass_score, attempts_per_calendar_day,
    attempt_reset_timezone, published_by
  ) values (
    v_behavior_revision_id, v_behavior_test_id, 1,
    'db-v3-behavior-fixture', 'DB v3 behavior fixture', '', 'factory', 900,
    '{"modules":[]}'::jsonb, '{}'::jsonb, repeat('a', 64),
    private.public_questions_from_draft(v_variants #> '{0,questions}'),
    10, 15, 7, 8, 'Asia/Oral', v_admin_id
  );
  for v_variant in
    select value from jsonb_array_elements(v_variants) item(value)
    order by (value ->> 'variantNumber')::integer
  loop
    insert into public.test_revision_variants(
      stable_id, revision_id, variant_number, questions, question_count
    ) values (
      (v_variant ->> 'id')::uuid,
      v_behavior_revision_id,
      (v_variant ->> 'variantNumber')::smallint,
      private.public_questions_from_draft(v_variant -> 'questions'),
      10
    ) returning id into v_variant_id;
    insert into private.test_revision_variant_answer_keys(
      variant_id, revision_id, correct_option_ids, explanations
    ) values (
      v_variant_id, v_behavior_revision_id,
      private.correct_option_ids_from_draft(v_variant -> 'questions'),
      private.explanations_from_draft(v_variant -> 'questions')
    );
  end loop;
  update public.tests
  set current_revision_id = v_behavior_revision_id,
      content_version = 1, status = 'published'
  where id = v_behavior_test_id;

  -- This unreferenced ready object belongs to the old fixture course. The
  -- activation assertion later proves it is retired before ON DELETE SET NULL.
  insert into public.course_presentations(
    id, course_id, storage_bucket, storage_path, thumbnail_path,
    source_filename, byte_size, sha256, page_count, status,
    created_by, validated_at
  ) values (
    v_old_presentation_id, v_behavior_test_id, 'course-presentations',
    v_behavior_test_id::text || '/' || v_old_presentation_id::text || '/'
      || repeat('b', 64) || '.pdf',
    v_behavior_test_id::text || '/' || v_old_presentation_id::text || '/'
      || repeat('b', 64) || '-thumb.webp',
    'old-fixture.pdf', 1000, repeat('b', 64), 1, 'ready',
    v_admin_id, statement_timestamp()
  );

  perform set_config('request.jwt.claim.sub', v_participant_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_result := private.start_test_attempt_unmetered('db-v3-behavior-fixture');
  v_attempt_id := (v_result ->> 'attemptId')::uuid;
  select variant_id into v_variant_id
  from public.test_attempts where id = v_attempt_id;
  if v_attempt_id is null
    or jsonb_array_length(v_result -> 'questions') <> 10
    or v_result ? 'variantId' or v_result ? 'variantNumber'
    or v_result ->> 'courseId' <> v_behavior_test_id::text
    or v_result ->> 'revisionId' <> v_behavior_revision_id::text then
    raise exception 'attempt payload contract invalid: %', v_result;
  end if;

  v_replay := private.start_test_attempt_unmetered('db-v3-behavior-fixture');
  v_resumed_attempt_id := (v_replay ->> 'attemptId')::uuid;
  if v_resumed_attempt_id is distinct from v_attempt_id
    or v_replay -> 'questions' is distinct from v_result -> 'questions'
    or (select count(*) from public.test_attempts
        where user_id = v_participant_a and test_id = v_behavior_test_id) <> 1
    or (select variant_id from public.test_attempts where id = v_attempt_id)
      is distinct from v_variant_id then
    raise exception 'resume changed attempt/variant or consumed a new attempt';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_result := public.set_course_catalog_maintenance(v_admin_id, true);
  if (v_result ->> 'enabled')::boolean is not true
    or (v_result ->> 'changed')::boolean is not true then
    raise exception 'maintenance enable failed: %', v_result;
  end if;

  perform set_config('request.jwt.claim.sub', v_participant_a::text, true);
  v_replay := private.start_test_attempt_unmetered('db-v3-behavior-fixture');
  if (v_replay ->> 'attemptId')::uuid is distinct from v_attempt_id then
    raise exception 'maintenance prevented an existing attempt from resuming';
  end if;
  v_answers := pg_temp.make_attempt_answers(v_variant_id, 6);
  v_result := private.complete_test_attempt_unmetered(v_attempt_id, v_answers);
  if v_result ->> 'status' <> 'failed'
    or (v_result ->> 'score')::integer <> 6
    or (select count(*) from public.attestations
        where user_id = v_participant_a) <> 0
    or (select count(*) from public.certificates
        where user_id = v_participant_a) <> 0 then
    raise exception '6/10 grading or failure side effects invalid: %', v_result;
  end if;

  v_blocked := false;
  begin
    perform private.start_test_attempt_unmetered('db-v3-behavior-fixture');
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'COURSE_CATALOG_MAINTENANCE' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'maintenance allowed a new learner attempt';
  end if;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_result := public.set_course_catalog_maintenance(v_admin_id, false);
  if (v_result ->> 'enabled')::boolean is not false then
    raise exception 'maintenance disable failed: %', v_result;
  end if;

  perform set_config('request.jwt.claim.sub', v_participant_a::text, true);
  v_result := private.start_test_attempt_unmetered('db-v3-behavior-fixture');
  v_attempt_id := (v_result ->> 'attemptId')::uuid;
  select variant_id into v_variant_id
  from public.test_attempts where id = v_attempt_id;
  v_answers := pg_temp.make_attempt_answers(v_variant_id, 7);

  select question.value ->> 'id' into v_other_question_id
  from public.test_revision_variants variant
  cross join lateral jsonb_array_elements(variant.questions) question(value)
  where variant.revision_id = v_behavior_revision_id
    and variant.id <> v_variant_id
  limit 1;
  v_tampered_answers := jsonb_set(
    v_answers, '{0,questionId}', to_jsonb(v_other_question_id), false
  );
  v_blocked := false;
  begin
    perform private.complete_test_attempt_unmetered(
      v_attempt_id, v_tampered_answers
    );
  exception when check_violation then
    if sqlerrm = 'INVALID_ATTEMPT_QUESTION' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'cross-variant question ID was accepted';
  end if;

  v_tampered_answers := jsonb_set(
    v_answers, '{0,optionId}', to_jsonb(gen_random_uuid()::text), false
  );
  v_blocked := false;
  begin
    perform private.complete_test_attempt_unmetered(
      v_attempt_id, v_tampered_answers
    );
  exception when check_violation then
    if sqlerrm = 'INVALID_ATTEMPT_OPTION' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'foreign option ID was accepted';
  end if;

  v_result := private.complete_test_attempt_unmetered(v_attempt_id, v_answers);
  if v_result ->> 'status' <> 'passed'
    or (v_result ->> 'score')::integer <> 7
    or (select count(*) from public.attestations
        where user_id = v_participant_a) <> 1 then
    raise exception '7/10 threshold did not create one attestation: %', v_result;
  end if;
  select id into v_attestation_id
  from public.attestations where user_id = v_participant_a;
  v_certificate_id := private.issue_certificate_for_attestation(
    v_attestation_id, v_admin_id, 'manual'
  );
  if not exists (
    select 1 from public.certificates
    where id = v_certificate_id and attempt_id = v_attempt_id
      and score = 7 and pass_score = 7
  ) then
    raise exception 'passing attestation certificate issuance failed';
  end if;

  insert into private.certificate_export_jobs(
    id, actor_user_id, attestation_ids, state,
    requested, eligible, skipped
  ) values (
    gen_random_uuid(), v_admin_id, array[v_attestation_id], 'ready', 1, 1, 0
  ) returning id into v_export_job_id;

  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  v_result := public.list_learning_history_targets_page(
    v_admin_id, 25, 'catalog-', null, null
  );
  if (v_result ->> 'total')::integer <> 2
    or jsonb_array_length(v_result -> 'items') <> 2
    or exists (
      select 1 from jsonb_array_elements(v_result -> 'items') item
      where item ->> 'role' <> 'participant'
        or item ? 'capabilities' or item ? 'identity' or item ? 'organization'
    )
    or exists (
      select 1 from jsonb_array_elements(v_result -> 'items') item
      where item ->> 'id' = v_admin_id::text
    ) then
    raise exception 'narrow learning-history target picker leaked/broke: %', v_result;
  end if;
  v_blocked := false;
  begin
    perform public.get_admin_learning_history(v_admin_id, v_admin_id);
  exception when insufficient_privilege then
    if sqlerrm = 'LEARNING_HISTORY_TARGET_NOT_ALLOWED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'learning-history preview exposed an administrative target';
  end if;
  v_result := public.get_admin_learning_history(v_admin_id, v_participant_a);
  if (v_result #>> '{counts,attempts}')::integer <> 2
    or (v_result #>> '{counts,startedAttempts}')::integer <> 0
    or (v_result #>> '{counts,attestations}')::integer <> 1
    or (v_result #>> '{counts,activeCertificates}')::integer <> 1
    or (v_result ->> 'deletable')::boolean is not true then
    raise exception 'learning-history preview counts invalid: %', v_result;
  end if;

  v_result := public.delete_admin_learning_history(
    v_admin_id, v_participant_a,
    'Удаление истории в поведенческом SQL-тесте', v_history_key
  );
  if (v_result ->> 'deleted')::boolean is not true
    or (v_result ->> 'replayed')::boolean is not false
    or (v_result #>> '{counts,attempts}')::integer <> 2
    or (v_result #>> '{counts,attestations}')::integer <> 1
    or (v_result #>> '{counts,activeCertificates}')::integer <> 1
    or (v_result #>> '{counts,certificateExportJobs}')::integer <> 1
    or exists (select 1 from public.test_attempts where user_id = v_participant_a)
    or exists (select 1 from public.attestations where user_id = v_participant_a)
    or exists (select 1 from public.certificates where user_id = v_participant_a)
    or exists (select 1 from private.certificate_export_jobs
      where id = v_export_job_id)
    or not exists (select 1 from auth.users where id = v_participant_a)
    or not exists (select 1 from public.profiles where id = v_participant_a)
    or not exists (select 1 from public.user_roles where user_id = v_participant_a) then
    raise exception 'learning-history deletion/preservation failed: %', v_result;
  end if;

  v_replay := public.delete_admin_learning_history(
    v_admin_id, v_participant_a,
    'Удаление истории в поведенческом SQL-тесте', v_history_key
  );
  if (v_replay ->> 'replayed')::boolean is not true
    or v_replay -> 'counts' is distinct from v_result -> 'counts'
    or (select count(*) from public.admin_audit_log
        where action = 'learning_history.deleted'
          and batch_id = v_history_key) <> 1 then
    raise exception 'learning-history idempotency failed: %', v_replay;
  end if;

  v_replay := public.delete_admin_learning_history(
    v_admin_id, v_participant_a,
    'Повторное удаление уже пустой учебной истории', v_empty_history_key
  );
  if v_replay #>> '{__safetyhubRpcError,message}'
      <> 'LEARNING_HISTORY_ALREADY_DELETED' then
    raise exception 'empty-history safe code missing: %', v_replay;
  end if;

  -- Eight new rows in the Asia/Oral calendar day are accepted. Each is
  -- submitted with 0/10 only to permit creation of the next one; every new
  -- row still counts regardless of its result. Satisfy the learner-approval
  -- prerequisite explicitly so this scenario continues to isolate the
  -- downstream calendar-limit contract.
  update public.account_controls
  set approval_state = 'approved',
      approval_requested_at = null,
      approval_due_at = null,
      approval_decided_at = null,
      approval_decided_by = null,
      approval_rejection_reason = null
  where user_id = v_participant_b;

  perform set_config('request.jwt.claim.sub', v_participant_b::text, true);
  for v_index in 1..8 loop
    v_result := public.start_test_attempt('db-v3-behavior-fixture');
    if v_result ? '__safetyhubRpcError'
      or jsonb_array_length(v_result -> 'questions') <> 10 then
      raise exception 'daily attempt % unexpectedly rejected: %', v_index, v_result;
    end if;
    v_attempt_id := (v_result ->> 'attemptId')::uuid;
    select variant_id into v_variant_id
    from public.test_attempts where id = v_attempt_id;
    v_answers := pg_temp.make_attempt_answers(v_variant_id, 0);
    v_replay := private.complete_test_attempt_unmetered(v_attempt_id, v_answers);
    if v_replay ->> 'status' <> 'failed'
      or (v_replay ->> 'score')::integer <> 0 then
      raise exception 'daily fixture attempt % did not finish 0/10: %',
        v_index, v_replay;
    end if;
  end loop;
  v_retry_at := (
    (statement_timestamp() at time zone 'Asia/Oral')::date + 1
  )::timestamp at time zone 'Asia/Oral';
  v_result := public.start_test_attempt('db-v3-behavior-fixture');
  if v_result #>> '{__safetyhubRpcError,code}' <> '54000'
    or v_result #>> '{__safetyhubRpcError,message}' <> 'ATTEMPT_DAILY_LIMIT'
    or (v_result #>> '{__safetyhubRpcError,details,retryAt}')::timestamptz
      is distinct from v_retry_at
    or (select count(*) from public.test_attempts
        where user_id = v_participant_b and test_id = v_behavior_test_id) <> 8 then
    raise exception '8-to-9 calendar limit/retryAt invalid: %', v_result;
  end if;

  -- Build the exact five-course batch through the public draft contract and
  -- finalize every presentation through the durable two-phase metadata RPC.
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  for v_index in 1..5 loop
    v_variants := pg_temp.make_course_variants(v_slugs[v_index]);
    v_result := public.save_course_draft_v3(
      p_actor_id => v_admin_id,
      p_test_id => null,
      p_expected_version => null,
      p_slug => v_slugs[v_index],
      p_title => v_titles[v_index],
      p_description => 'Поведенческий каталог v3',
      p_icon => 'factory',
      p_display_order => v_index,
      p_presentation_id => null,
      p_duration_minutes => 15,
      p_pass_score => 7,
      p_attempts_per_calendar_day => 8,
      p_attempt_reset_timezone => 'Asia/Oral',
      p_question_variants => v_variants,
      p_seo => '{}'::jsonb,
      p_content_metadata => '{}'::jsonb
    );
    if v_result ? '__safetyhubRpcError' then
      raise exception 'course shell % failed: %', v_slugs[v_index], v_result;
    end if;
    v_course_id := (v_result ->> 'id')::uuid;
    v_draft_version := (v_result ->> 'draftVersion')::bigint;
    v_test_ids := array_append(v_test_ids, v_course_id);

    v_presentation_id := gen_random_uuid();
    v_presentation_ids := array_append(v_presentation_ids, v_presentation_id);
    v_upload_id := gen_random_uuid();
    v_sha256 := encode(extensions.digest(
      convert_to('presentation:' || v_slugs[v_index], 'utf8'), 'sha256'
    ), 'hex');
    v_staging_path := v_admin_id::text || '/' || v_upload_id::text
      || '/source.pdf';
    v_thumbnail_path := v_admin_id::text || '/' || v_upload_id::text
      || '/thumbnail.webp';
    insert into public.course_presentations(
      id, course_id, storage_bucket, storage_path, thumbnail_path,
      source_filename, byte_size, sha256, page_count, status, created_by
    ) values (
      v_presentation_id, v_course_id, 'course-presentations-staging',
      v_staging_path, v_thumbnail_path, v_slugs[v_index] || '.pdf',
      1000 + v_index, v_sha256, v_pages[v_index], 'validating', v_admin_id
    );

    v_result := public.finalize_course_presentation_metadata(
      v_admin_id, v_course_id, v_presentation_id, v_sha256,
      v_pages[v_index], 1000 + v_index, v_staging_path, v_thumbnail_path
    );
    if v_result ? '__safetyhubRpcError'
      or v_result #>> '{presentation,status}' <> 'ready'
      or v_result #>> '{presentation,storageBucket}' <> 'course-presentations'
      or v_result #>> '{cleanup,bucket}' <> 'course-presentations-staging' then
      raise exception 'durable presentation finalize failed: %', v_result;
    end if;
    v_cleanup_id := (v_result #>> '{cleanup,id}')::uuid;
    v_replay := public.finalize_course_presentation_metadata(
      v_admin_id, v_course_id, v_presentation_id, v_sha256,
      v_pages[v_index], 1000 + v_index, v_staging_path, v_thumbnail_path
    );
    if (v_replay ->> 'replayed')::boolean is not true
      or (v_replay #>> '{cleanup,id}')::uuid is distinct from v_cleanup_id then
      raise exception 'presentation finalize retry lost cleanup receipt: %', v_replay;
    end if;
    v_result := public.complete_course_presentation_cleanup(
      array[v_cleanup_id]
    );
    if (v_result ->> 'deleted')::integer <> 1 then
      raise exception 'presentation staging cleanup acknowledgement failed: %', v_result;
    end if;

    v_result := public.save_course_draft_v3(
      p_actor_id => v_admin_id,
      p_test_id => v_course_id,
      p_expected_version => v_draft_version,
      p_slug => v_slugs[v_index],
      p_title => v_titles[v_index],
      p_description => 'Поведенческий каталог v3',
      p_icon => 'factory',
      p_display_order => v_index,
      p_presentation_id => v_presentation_id,
      p_duration_minutes => 15,
      p_pass_score => 7,
      p_attempts_per_calendar_day => 8,
      p_attempt_reset_timezone => 'Asia/Oral',
      p_question_variants => v_variants,
      p_seo => '{}'::jsonb,
      p_content_metadata => '{}'::jsonb
    );
    if v_result ? '__safetyhubRpcError'
      or coalesce(v_result ->> 'contentHash', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'course presentation attach % failed: %',
        v_slugs[v_index], v_result;
    end if;

    if v_index = 1 then
      v_unused_presentation_id := gen_random_uuid();
      v_upload_id := gen_random_uuid();
      v_sha256 := encode(extensions.digest(
        convert_to('unused-presentation', 'utf8'), 'sha256'
      ), 'hex');
      insert into public.course_presentations(
        id, course_id, storage_bucket, storage_path, source_filename,
        byte_size, sha256, page_count, status, created_by
      ) values (
        v_unused_presentation_id, v_course_id,
        'course-presentations-staging',
        v_admin_id::text || '/' || v_upload_id::text || '/source.pdf',
        'unused.pdf', 500, v_sha256, 1, 'staging', v_admin_id
      );
      v_result := public.retire_course_presentation(
        v_admin_id, v_course_id, v_unused_presentation_id
      );
      if v_result ? '__safetyhubRpcError'
        or v_result ->> 'status' <> 'retired'
        or (v_result ->> 'changed')::boolean is not true then
        raise exception 'unreferenced presentation retirement failed: %', v_result;
      end if;
    end if;
  end loop;

  -- Ready ownership cannot be rebound, and reference detection plus retirement
  -- is one row-lock transaction rather than a query/update race.
  v_blocked := false;
  begin
    update public.course_presentations
    set course_id = v_test_ids[2]
    where id = v_presentation_ids[1];
  exception when object_in_use then
    if sqlerrm = 'PRESENTATION_IN_USE' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'ready presentation course association was mutable';
  end if;

  v_result := public.retire_course_presentation(
    v_admin_id, v_test_ids[1], v_presentation_ids[1]
  );
  if v_result #>> '{__safetyhubRpcError,message}' <> 'PRESENTATION_IN_USE' then
    raise exception 'referenced presentation retirement was not rejected: %', v_result;
  end if;

  -- The course editor may now read the saved question bank, and every read is
  -- audited. The bank must come back complete and shaped for the editor.
  v_result := public.read_course_question_bank_v4(v_admin_id, v_test_ids[1]);
  if (v_result ->> 'bankAvailable')::boolean is not true
    or jsonb_array_length(v_result -> 'questionVariants') <> 3
    or jsonb_array_length(v_result #> '{questionVariants,0,questions}') <> 10
    or jsonb_array_length(v_result #> '{questionVariants,0,questions,0,options}') <> 4
    or coalesce(v_result #>> '{questionVariants,0,questions,0,correctOptionId}', '') = ''
    or coalesce(v_result #>> '{questionVariants,0,questions,0,text}', '') = ''
    or v_result #> '{questionVariants,0,questions,0}' ? 'displayOrder' then
    raise exception 'course editor question bank read invalid: %', v_result;
  end if;
  if not exists (
    select 1
    from public.admin_audit_log entry
    where entry.action = 'course.question_bank_read'
      and entry.target_id = v_test_ids[1]::text
      and entry.actor_user_id = v_admin_id
      and (entry.after_data ->> 'bankAvailable')::boolean
      and not (entry.after_data::text ilike '%correctOptionId%')
  ) then
    raise exception 'course question bank read was not audited without answer keys';
  end if;

  -- A participant must never reach it, capability or not.
  perform set_config('request.jwt.claim.sub', v_participant_b::text, true);
  v_blocked := false;
  begin
    perform public.read_course_question_bank_v4(v_participant_b, v_test_ids[1]);
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'participant read the course question bank';
  end if;
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);

  -- Regression: saving a blank bank over a complete one used to wipe 30
  -- questions when an administrator edited a single line.
  select draft_version into v_draft_version
  from public.course_drafts where test_id = v_test_ids[1];
  v_result := public.save_course_draft_v3(
    p_actor_id => v_admin_id,
    p_test_id => v_test_ids[1],
    p_expected_version => v_draft_version,
    p_slug => v_slugs[1],
    p_title => v_titles[1],
    p_description => 'Поведенческий каталог v3',
    p_icon => 'factory',
    p_display_order => 1,
    p_presentation_id => v_presentation_ids[1],
    p_duration_minutes => 15,
    p_pass_score => 7,
    p_attempts_per_calendar_day => 8,
    p_attempt_reset_timezone => 'Asia/Oral',
    p_question_variants => '[]'::jsonb,
    p_seo => '{}'::jsonb,
    p_content_metadata => '{}'::jsonb
  );
  if v_result #>> '{__safetyhubRpcError,message}' <> 'COURSE_QUESTION_BANK_MISSING' then
    raise exception 'blank question bank overwrote a complete one: %', v_result;
  end if;
  if not private.course_question_variants_valid(
    (select question_variants from public.course_drafts where test_id = v_test_ids[1])
  ) then
    raise exception 'stored question bank was damaged by a rejected save';
  end if;

  v_result := public.prepare_course_catalog_batch(v_admin_id, v_test_ids);
  if v_result ? '__safetyhubRpcError'
    or v_result ->> 'status' <> 'staging' then
    raise exception 'catalogue batch preparation failed: %', v_result;
  end if;
  v_batch_id := (v_result ->> 'batchId')::uuid;

  v_blocked := false;
  begin
    perform private.activate_course_catalog_batch_unmetered(
      v_admin_id, v_batch_id, v_activation_key
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'CATALOG_MAINTENANCE_REQUIRED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'catalogue activation ran without maintenance';
  end if;

  v_result := public.set_course_catalog_maintenance(v_admin_id, true);
  if (v_result ->> 'enabled')::boolean is not true then
    raise exception 'activation maintenance enable failed: %', v_result;
  end if;
  select content_hash into v_sha256
  from public.course_drafts where test_id = v_test_ids[1];
  v_replay := public.publish_course_revision_v3(
    v_admin_id, v_test_ids[1], v_sha256
  );
  if v_replay #>> '{__safetyhubRpcError,message}'
      <> 'COURSE_CATALOG_MAINTENANCE' then
    raise exception 'maintenance allowed course publication: %', v_replay;
  end if;
  v_blocked := false;
  begin
    update public.tests set title = title where id = v_test_ids[1];
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'COURSE_CATALOG_MAINTENANCE' then
      v_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_blocked then
    raise exception 'maintenance DML trigger allowed course mutation';
  end if;

  select count(*) into v_auth_count from auth.users;
  select count(*) into v_profile_count from public.profiles;
  select count(*) into v_article_count from public.articles;
  v_result := public.activate_course_catalog_batch(
    v_admin_id, v_batch_id, v_activation_key
  );
  if v_result ? '__safetyhubRpcError'
    or v_result ->> 'status' <> 'activated'
    or (v_result ->> 'maintenanceEnabled')::boolean is not true
    or (v_result #>> '{published,courses}')::integer <> 5
    or (v_result #>> '{published,revisions}')::integer <> 5
    or (v_result #>> '{published,variants}')::integer <> 15
    or (v_result #>> '{published,questions}')::integer <> 150
    or (v_result #>> '{published,options}')::integer <> 600 then
    raise exception 'atomic catalogue activation failed: %', v_result;
  end if;

  if (select count(*) from public.tests where status = 'published') <> 5
    or (select array_agg(slug order by slug) from public.tests)
      is distinct from array[
        'armaturshchik', 'biot', 'lesomontazhnye-raboty',
        'plotnik', 'pozharnaya-bezopasnost'
      ]::text[]
    or (select count(*) from public.test_revision_variants variant
        join public.tests test on test.current_revision_id = variant.revision_id)
      <> 15
    or (select coalesce(sum(variant.question_count), 0)
        from public.test_revision_variants variant
        join public.tests test on test.current_revision_id = variant.revision_id)
      <> 150
    or (select count(*)
        from public.test_revision_variants variant
        join public.tests test on test.current_revision_id = variant.revision_id
        cross join lateral jsonb_array_elements(variant.questions) question
        cross join lateral jsonb_array_elements(question -> 'options') option)
      <> 600
    or exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates)
    or (select count(*) from auth.users) <> v_auth_count
    or (select count(*) from public.profiles) <> v_profile_count
    or (select count(*) from public.articles) <> v_article_count then
    raise exception 'catalogue activation postconditions/preservation failed';
  end if;
  if not exists (
    select 1 from public.course_presentations
    where id = v_old_presentation_id and status = 'retired'
      and course_id is null
  ) then
    raise exception 'old ready presentation was not retired before course deletion';
  end if;

  select public.get_published_course_snapshot_v3(test.id)
  into v_snapshot
  from public.tests test where test.slug = 'plotnik';
  if v_snapshot ->> 'contentHash' is distinct from (
      select revision.content_hash
      from public.tests test
      join public.test_revisions revision on revision.id = test.current_revision_id
      where test.slug = 'plotnik'
    )
    or not private.course_question_variants_valid(v_snapshot -> 'variants')
    or jsonb_array_length(v_snapshot -> 'variants') <> 3
    or jsonb_array_length(v_snapshot #> '{variants,0,questions}') <> 10
    or v_snapshot #>> '{variants,0,id}' is distinct from (
      select variant.stable_id::text
      from public.tests test
      join public.test_revision_variants variant
        on variant.revision_id = test.current_revision_id
      where test.slug = 'plotnik' and variant.variant_number = 1
    ) then
    raise exception 'published snapshot/hash/stable-id reconstruction failed: %',
      v_snapshot;
  end if;

  v_replay := public.get_course_catalog_maintenance(v_admin_id);
  if (v_replay ->> 'enabled')::boolean is not true then
    raise exception 'activation did not deterministically leave maintenance enabled';
  end if;
  v_replay := public.set_course_catalog_maintenance(v_admin_id, false);
  if (v_replay ->> 'enabled')::boolean is not false then
    raise exception 'post-activation maintenance disable failed: %', v_replay;
  end if;
  delete from private.business_rate_limits
  where actor_id = v_admin_id
    and action = 'admin.test.mutate';
  v_replay := public.save_course_draft_v2(
    v_admin_id, v_test_ids[1], null, 'legacy-after-v3', 'Legacy after v3',
    'must be rejected', 'factory', 15, '{}'::jsonb, '[]'::jsonb,
    '{}'::jsonb, '{}'::jsonb
  );
  if v_replay #>> '{__safetyhubRpcError,message}'
      <> 'COURSE_EDITOR_VERSION_RETIRED' then
    raise exception 'legacy v2 draft mutation survived activation: %', v_replay;
  end if;
  v_replay := public.publish_course_revision_v2(
    v_admin_id, v_test_ids[1], repeat('0', 64)
  );
  if v_replay #>> '{__safetyhubRpcError,message}'
      <> 'COURSE_EDITOR_VERSION_RETIRED' then
    raise exception 'legacy v2 publication survived activation: %', v_replay;
  end if;
  v_replay := public.save_and_publish_course_v2(
    v_admin_id, v_test_ids[1], null, 'legacy-after-v3', 'Legacy after v3',
    'must be rejected', 'factory', 15, '{}'::jsonb, '[]'::jsonb,
    '{}'::jsonb, '{}'::jsonb
  );
  if v_replay #>> '{__safetyhubRpcError,message}'
      <> 'COURSE_EDITOR_VERSION_RETIRED' then
    raise exception 'legacy v2 atomic mutation survived activation: %', v_replay;
  end if;
  v_replay := public.activate_course_catalog_batch(
    v_admin_id, v_batch_id, v_activation_key
  );
  if (v_replay ->> 'replayed')::boolean is not true
    or v_replay ->> 'catalogChecksum'
      is distinct from v_result ->> 'catalogChecksum' then
    raise exception 'catalogue activation idempotency failed: %', v_replay;
  end if;
end;
$behavior$;

rollback;
