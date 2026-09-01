begin;

do $test$
declare
  v_locales text[];
  v_definition text;
begin
  select array_agg(enum_value::text order by enum_order)
  into v_locales
  from unnest(enum_range(null::public.app_locale))
    with ordinality locale(enum_value, enum_order);
  if v_locales is distinct from array['ru','kk','en','zh']::text[] then
    raise exception 'app_locale contract is incorrect: %', v_locales;
  end if;

  if to_regclass('public.course_draft_localizations') is null
    or to_regclass('public.test_revision_localizations') is null
    or to_regclass('public.test_revision_variant_localizations') is null
    or to_regclass('public.article_draft_localizations') is null
    or to_regclass('public.article_revision_localizations') is null
    or to_regclass('public.legal_document_localizations') is null
    or to_regclass('public.test_revision_presentations') is null then
    raise exception 'multilingual content schema is incomplete';
  end if;

  if not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name = 'profiles'
      and column_definition.column_name = 'preferred_locale'
      and column_definition.is_nullable = 'NO'
  ) or not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name = 'test_attempts'
      and column_definition.column_name = 'locale'
      and column_definition.is_nullable = 'NO'
  ) or not exists (
    select 1
    from information_schema.columns column_definition
    where column_definition.table_schema = 'public'
      and column_definition.table_name = 'certificates'
      and column_definition.column_name = 'localized_test_title'
      and column_definition.is_nullable = 'NO'
  ) then
    raise exception 'locale snapshot/profile columns are incomplete';
  end if;

  if has_table_privilege('anon', 'public.course_draft_localizations', 'select')
    or has_table_privilege('authenticated', 'public.course_draft_localizations', 'select')
    or has_table_privilege('anon', 'public.test_revision_variant_localizations', 'select')
    or has_table_privilege('authenticated', 'public.test_revision_variant_localizations', 'select')
    or has_table_privilege('anon', 'public.article_draft_localizations', 'select')
    or has_table_privilege('authenticated', 'public.article_draft_localizations', 'select') then
    raise exception 'localized draft/question tables leaked to browser roles';
  end if;

  if not has_function_privilege(
    'anon', 'public.get_published_course_locale(text,public.app_locale)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.get_published_course_locale(text,public.app_locale)', 'execute'
  ) or not has_function_privilege(
    'anon', 'public.list_published_courses_locale(public.app_locale)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.list_published_courses_locale(public.app_locale)', 'execute'
  ) or not has_function_privilege(
    'anon', 'public.get_published_article_locale(text,public.app_locale)', 'execute'
  ) or has_function_privilege(
    'anon', 'public.save_course_localization_draft(uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,uuid)', 'execute'
  ) or not has_function_privilege(
    'authenticated', 'public.save_course_localization_draft(uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,jsonb,text,jsonb,uuid)', 'execute'
  ) then
    raise exception 'locale RPC grants are incorrect';
  end if;

  if has_function_privilege(
    'anon', 'public.import_course_assessment_localization(uuid,uuid,public.app_locale,bigint,jsonb)', 'execute'
  ) or has_function_privilege(
    'authenticated', 'public.import_course_assessment_localization(uuid,uuid,public.app_locale,bigint,jsonb)', 'execute'
  ) or not has_function_privilege(
    'service_role', 'public.import_course_assessment_localization(uuid,uuid,public.app_locale,bigint,jsonb)', 'execute'
  ) then
    raise exception 'localized assessment import RPC grants are unsafe';
  end if;

  select lower(pg_get_functiondef(
    'public.import_course_assessment_localization(uuid,uuid,public.app_locale,bigint,jsonb)'::regprocedure
  )) into v_definition;
  if position('auth.role() is distinct from ''service_role''' in v_definition) = 0
    or position('consume_business_quota_for_actor' in v_definition) = 0
    or position('admin.test.mutate' in v_definition) = 0
    or position('localized_assessment_structure' in v_definition) = 0
    or position('assessment_localization_structure_mismatch' in v_definition) = 0
    or position('test_revision_variant_answer_keys' in v_definition) > 0
    or position('correctoptionid' in v_definition) > 0 then
    raise exception 'localized assessment import boundary is incomplete';
  end if;

  select lower(pg_get_functiondef(
    'public.list_published_courses_locale(public.app_locale)'::regprocedure
  )) into v_definition;
  if position('limit 100' in v_definition) = 0
    or position('test_revision_variant' in v_definition) > 0
    or position('answer_key' in v_definition) > 0
    or position('storage_path' in v_definition) > 0
    or position('thumbnail_path' in v_definition) > 0 then
    raise exception 'localized course list is unbounded or leaks private metadata';
  end if;

  select lower(pg_get_functiondef(
    'private.attempt_payload(uuid,timestamptz)'::regprocedure
  )) into v_definition;
  if position('''locale''' in v_definition) = 0
    or position('test_revision_variant_localizations' in v_definition) = 0
    or position('''correctoptionid''' in v_definition) > 0
    or position('''variantid''' in v_definition) > 0
    or position('''review''' in v_definition) > 0 then
    raise exception 'localized attempt payload violates answer-key/locale contract';
  end if;

  select lower(pg_get_functiondef(
    'public.publish_course_revision_v4(uuid,uuid,text)'::regprocedure
  )) into v_definition;
  if position('assert_course_draft_localizations_complete' in v_definition) = 0
    or position('assert_course_revision_localizations_complete' in v_definition) = 0
    or position('for update' in v_definition) = 0 then
    raise exception 'course publication is not guarded by four-locale validators';
  end if;

  select lower(pg_get_functiondef(
    'public.get_course_editor_localizations(uuid,uuid)'::regprocedure
  )) into v_definition;
  if position('questionvariants' in v_definition) > 0
    or position('correctoptionid' in v_definition) > 0 then
    raise exception 'course editor returns a saved question bank or answer key';
  end if;

  select lower(pg_get_functiondef(
    'private.certificate_download_payload(uuid)'::regprocedure
  )) into v_definition;
  if position('''locale''' in v_definition) = 0
    or position('''titlesnapshot''' in v_definition) = 0
    or position('''templateversion''' in v_definition) = 0
    or position('''bestcompletedat''' in v_definition) = 0 then
    raise exception 'certificate metadata locale snapshot contract is incomplete';
  end if;

  if not exists (
    select 1 from pg_trigger trigger_definition
    where trigger_definition.tgrelid = 'public.test_attempts'::regclass
      and trigger_definition.tgname = 'test_attempts_locale_immutable'
      and not trigger_definition.tgisinternal
  ) or not exists (
    select 1 from pg_trigger trigger_definition
    where trigger_definition.tgrelid = 'public.certificates'::regclass
      and trigger_definition.tgname = 'certificates_snapshot_guard'
      and not trigger_definition.tgisinternal
  ) then
    raise exception 'attempt/certificate immutable snapshot triggers are missing';
  end if;

  select pg_get_constraintdef(constraint_definition.oid)
  into v_definition
  from pg_constraint constraint_definition
  where constraint_definition.conrelid = 'public.course_presentations'::regclass
    and constraint_definition.conname = 'course_presentation_ready_immutable_path';
  if position('locale' in lower(coalesce(v_definition, ''))) = 0 then
    raise exception 'localized presentation path contract is missing';
  end if;

  select lower(pg_get_functiondef(
    'public.finalize_course_presentation_metadata(uuid,uuid,uuid,text,integer,bigint,text,text)'::regprocedure
  )) into v_definition;
  if position('v_presentation.locale' in v_definition) = 0
    or position('course.presentation_finalized' in v_definition) = 0
    or position('''locale'', v_cleanup.locale' in v_definition) = 0 then
    raise exception 'presentation finalizer is not bound to the locked locale row';
  end if;

  if exists (
    select 1
    from public.legal_document_localizations localization
    where localization.body_hash is distinct from encode(
      extensions.digest(
        convert_to(localization.body::text, 'UTF8'),
        'sha256'
      ),
      'hex'
    )
  ) then
    raise exception 'legal localization body hashes are not canonical';
  end if;

  select lower(pg_get_functiondef(
    'public.save_legal_document_localization(public.legal_document_type,text,public.app_locale,text,jsonb,text,boolean)'::regprocedure
  )) into v_definition;
  if position('v_computed_hash' in v_definition) = 0
    or position('p_body_hash is not null' in v_definition) = 0 then
    raise exception 'legal localization hash must be server-computed';
  end if;

  if not has_function_privilege(
    'authenticated', 'public.start_test_attempt_locale(text,public.app_locale)', 'execute'
  ) or has_function_privilege(
    'anon', 'public.start_test_attempt_locale(text,public.app_locale)', 'execute'
  ) then
    raise exception 'locale-aware attempt start grants are unsafe';
  end if;
end;
$test$;

rollback;
