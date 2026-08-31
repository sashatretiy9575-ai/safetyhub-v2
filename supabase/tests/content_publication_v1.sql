begin;

do $test$
declare
  v_relation text;
  v_test_labels text[];
  v_article_labels text[];
begin
  foreach v_relation in array array[
    'public.course_drafts',
    'public.course_slug_redirects',
    'public.article_drafts',
    'public.article_revisions',
    'public.content_assets',
    'public.content_asset_usages'
  ] loop
    if to_regclass(v_relation) is null then
      raise exception 'content relation missing: %', v_relation;
    end if;
    if not exists (
      select 1
      from pg_class relation
      where relation.oid = to_regclass(v_relation)
        and relation.relrowsecurity
    ) then
      raise exception 'content RLS is disabled: %', v_relation;
    end if;
  end loop;

  if to_regprocedure(
      'public.save_course_draft(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)'
    ) is null
    or to_regprocedure(
      'public.save_course_draft_v2(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)'
    ) is null
    or to_regprocedure('public.change_course_slug(uuid,uuid,bigint,text)') is null
    or to_regprocedure('public.publish_course_revision(uuid,uuid,text)') is null
    or to_regprocedure('public.publish_course_revision_v2(uuid,uuid,text)') is null
    or to_regprocedure(
      'public.save_and_publish_course_v2(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)'
    ) is null
    or to_regprocedure('public.resolve_course_slug(text)') is null
    or to_regprocedure('public.delete_course(uuid,uuid,bigint)') is null
    or to_regprocedure('public.delete_article(uuid,bigint)') is null
    or to_regprocedure(
      'public.save_and_publish_article_v2(uuid,text,text,text,text,text,jsonb,jsonb)'
    ) is null
    or to_regprocedure('public.mark_content_asset_orphan(uuid,uuid)') is null
    or to_regprocedure('public.delete_verified_orphan_asset(uuid,uuid)') is null then
    raise exception 'two-state content RPC contract missing';
  end if;

  if to_regprocedure('public.review_course_draft(uuid,uuid,text)') is not null
    or to_regprocedure('public.review_article_draft(uuid,text)') is not null
    or to_regprocedure('public.delete_unused_course_draft(uuid,uuid)') is not null
    or to_regprocedure(
      'public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)'
    ) is not null then
    raise exception 'obsolete review or archive-era RPC remains installed';
  end if;

  select array_agg(enum_value.enumlabel order by enum_value.enumsortorder)
  into v_test_labels
  from pg_enum enum_value
  join pg_type enum_type on enum_type.oid = enum_value.enumtypid
  join pg_namespace namespace on namespace.oid = enum_type.typnamespace
  where namespace.nspname = 'public' and enum_type.typname = 'test_status';

  select array_agg(enum_value.enumlabel order by enum_value.enumsortorder)
  into v_article_labels
  from pg_enum enum_value
  join pg_type enum_type on enum_type.oid = enum_value.enumtypid
  join pg_namespace namespace on namespace.oid = enum_type.typnamespace
  where namespace.nspname = 'public' and enum_type.typname = 'article_status';

  if v_test_labels is distinct from array['draft', 'published']::text[]
    or v_article_labels is distinct from array['draft', 'published']::text[] then
    raise exception 'content lifecycle enums are not exactly draft/published';
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (
        'tests', 'test_revisions', 'course_drafts',
        'articles', 'article_drafts', 'article_revisions'
      )
      and column_name in (
        'reviewer', 'reviewed_at', 'next_review_at', 'reviewed_content_hash'
      )
  ) then
    raise exception 'obsolete review columns remain installed';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'certificates'
      and column_name = 'course_deleted_at'
      and is_nullable = 'YES'
  ) or exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'certificates'
      and column_name in ('revision_id', 'attempt_id', 'attestation_id')
      and is_nullable <> 'YES'
  ) then
    raise exception 'historical certificate link contract missing';
  end if;

  if has_function_privilege(
      'anon',
      'public.save_course_draft(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)',
      'execute'
    )
    or has_function_privilege('anon', 'public.publish_course_revision(uuid,uuid,text)', 'execute')
    or has_function_privilege(
      'anon',
      'public.save_and_publish_course_v2(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)',
      'execute'
    )
    or has_function_privilege('anon', 'public.delete_course(uuid,uuid,bigint)', 'execute')
    or has_function_privilege('anon', 'public.delete_article(uuid,bigint)', 'execute')
    or has_function_privilege(
      'anon', 'public.save_and_publish_article_v2(uuid,text,text,text,text,text,jsonb,jsonb)',
      'execute'
    ) then
    raise exception 'anonymous content mutation remains executable';
  end if;

  if not has_function_privilege(
      'authenticated',
      'public.save_course_draft(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.publish_course_revision(uuid,uuid,text)', 'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.save_and_publish_course_v2(uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb)',
      'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.delete_course(uuid,uuid,bigint)', 'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.delete_article(uuid,bigint)', 'execute'
    )
    or not has_function_privilege(
      'authenticated',
      'public.save_and_publish_article_v2(uuid,text,text,text,text,text,jsonb,jsonb)',
      'execute'
    )
    or not has_function_privilege('anon', 'public.resolve_course_slug(text)', 'execute')
    or not has_function_privilege(
      'authenticated', 'public.mark_content_asset_orphan(uuid,uuid)', 'execute'
    )
    or not has_function_privilege(
      'authenticated', 'public.delete_verified_orphan_asset(uuid,uuid)', 'execute'
    ) then
    raise exception 'expected content execute grant missing';
  end if;

  if not has_table_privilege('service_role', 'public.organizations', 'select')
    or not has_table_privilege('service_role', 'public.organization_aliases', 'select')
    or not has_table_privilege('service_role', 'public.course_drafts', 'select')
    or not has_table_privilege('service_role', 'public.article_revisions', 'select') then
    raise exception 'service-role maintenance grant missing';
  end if;

  if not has_column_privilege('anon', 'public.tests', 'id', 'select')
    or has_column_privilege('anon', 'public.tests', 'title', 'select')
    or has_column_privilege('anon', 'public.tests', 'draft_content', 'select')
    or not has_column_privilege('anon', 'public.test_revisions', 'content', 'select')
    or has_column_privilege('anon', 'public.test_revisions', 'published_by', 'select') then
    raise exception 'public course revision projection is unsafe';
  end if;

  if position('for update' in lower(pg_get_functiondef(
      'private.publish_course_revision_v2_unmetered(uuid,uuid,text)'::regprocedure
    ))) = 0
    or position('content_hash is distinct from p_expected_content_hash' in lower(
      pg_get_functiondef(
        'private.publish_course_revision_v2_unmetered(uuid,uuid,text)'::regprocedure
      )
    )) = 0
    or position('insert into public.test_revisions' in lower(pg_get_functiondef(
      'private.publish_course_revision_v2_unmetered(uuid,uuid,text)'::regprocedure
    ))) = 0
    or position('current_revision_id' in lower(pg_get_functiondef(
      'private.publish_course_revision_v2_unmetered(uuid,uuid,text)'::regprocedure
    ))) = 0 then
    raise exception 'atomic direct course publication invariants missing';
  end if;

  if position('review' in lower(pg_get_functiondef(
      'private.publish_course_revision_v2_unmetered(uuid,uuid,text)'::regprocedure
    ))) > 0
    or position('review' in lower(pg_get_functiondef(
      'private.set_article_status_v2_unmetered(uuid,public.article_status,text)'::regprocedure
    ))) > 0 then
    raise exception 'direct publication still depends on review state';
  end if;

  if position('p_jurisdiction' in lower(pg_get_functiondef(
      'private.course_content_hash_v2(text,text,text,text,integer,jsonb,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0
    or position('p_effective_date' in lower(pg_get_functiondef(
      'private.course_content_hash_v2(text,text,text,text,integer,jsonb,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0
    or position('p_sources' in lower(pg_get_functiondef(
      'private.course_content_hash_v2(text,text,text,text,integer,jsonb,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0
    or position('p_jurisdiction' in lower(pg_get_functiondef(
      'private.article_content_hash_v2(text,text,text,text,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0
    or position('p_effective_date' in lower(pg_get_functiondef(
      'private.article_content_hash_v2(text,text,text,text,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0
    or position('p_sources' in lower(pg_get_functiondef(
      'private.article_content_hash_v2(text,text,text,text,jsonb,jsonb,text,date,jsonb)'
        ::regprocedure
    ))) = 0 then
    raise exception 'optional metadata is missing from content identity';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'course_drafts'
      and column_name = 'question_variants'
  ) or to_regprocedure('private.course_question_variants_valid(jsonb)') is null then
    raise exception 'course draft v3 variant contract missing';
  end if;

  if exists (
    select 1
    from public.tests test
    where test.current_revision_id is not null
      and not exists (
        select 1
        from public.test_revisions revision
        where revision.id = test.current_revision_id
          and revision.test_id = test.id
          and revision.content_hash is not null
          and jsonb_typeof(revision.content) = 'object'
          and jsonb_typeof(revision.seo) = 'object'
      )
  ) then
    raise exception 'published course points to an incomplete revision snapshot';
  end if;

  if not exists (
    select 1
    from storage.buckets bucket
    where bucket.id = 'content-media'
      and bucket.public
      and bucket.file_size_limit = 2097152
      and bucket.allowed_mime_types = array['image/webp']::text[]
  ) then
    raise exception 'content-addressed media bucket contract missing';
  end if;

  if position('for update' in lower(pg_get_functiondef(
      'public.delete_course(uuid,uuid,bigint)'::regprocedure
    ))) = 0
    or position('course_deleted_at' in lower(pg_get_functiondef(
      'public.delete_course(uuid,uuid,bigint)'::regprocedure
    ))) = 0
    or position('set revision_id = null' in lower(pg_get_functiondef(
      'public.delete_course(uuid,uuid,bigint)'::regprocedure
    ))) = 0
    or position('delete from public.tests' in lower(pg_get_functiondef(
      'public.delete_course(uuid,uuid,bigint)'::regprocedure
    ))) = 0
    or position('orphan_candidate' in lower(pg_get_functiondef(
      'public.delete_course(uuid,uuid,bigint)'::regprocedure
    ))) = 0 then
    raise exception 'transactional course deletion invariants missing';
  end if;

  if position('for update' in lower(pg_get_functiondef(
      'public.delete_article(uuid,bigint)'::regprocedure
    ))) = 0
    or position('delete from public.articles' in lower(pg_get_functiondef(
      'public.delete_article(uuid,bigint)'::regprocedure
    ))) = 0
    or position('orphan_candidate' in lower(pg_get_functiondef(
      'public.delete_article(uuid,bigint)'::regprocedure
    ))) = 0 then
    raise exception 'transactional article deletion invariants missing';
  end if;

  if to_regclass('private.admin_attestation_rows') is null
    or position('course_deleted_at is not null' in lower(pg_get_viewdef(
      'private.admin_attestation_rows'::regclass, true
    ))) = 0
    or position('deleted-course-certificate' in lower(pg_get_functiondef(
      'public.list_admin_attestations_page(integer,text,text,uuid,text,text,timestamptz,timestamptz,text,jsonb)'
        ::regprocedure
    ))) = 0
    or position('recordid' in lower(pg_get_functiondef(
      'public.list_admin_attestations_page(integer,text,text,uuid,text,text,timestamptz,timestamptz,text,jsonb)'
        ::regprocedure
    ))) = 0
    or position('coursedeleted' in lower(pg_get_functiondef(
      'public.list_admin_attestations_page(integer,text,text,uuid,text,text,timestamptz,timestamptz,text,jsonb)'
        ::regprocedure
    ))) = 0 then
    raise exception 'deleted-course certificate ledger contract missing';
  end if;

  if position('course_deleted_at' in lower(pg_get_functiondef(
      'private.certificate_download_payload(uuid)'::regprocedure
    ))) > 0
    or position('coursedeleted' in lower(pg_get_functiondef(
      'private.certificate_download_payload(uuid)'::regprocedure
    ))) > 0
    or position('course_deleted_at' in lower(pg_get_functiondef(
      'public.get_public_certificate(uuid)'::regprocedure
    ))) > 0
    or position('coursedeleted' in lower(pg_get_functiondef(
      'public.get_public_certificate(uuid)'::regprocedure
    ))) > 0 then
    raise exception 'certificate projection leaks course deletion metadata';
  end if;

  if position('content_asset_usages' in lower(pg_get_functiondef(
      'public.delete_verified_orphan_asset(uuid,uuid)'::regprocedure
    ))) = 0
    or position('delete_pending' in lower(pg_get_functiondef(
      'public.delete_verified_orphan_asset(uuid,uuid)'::regprocedure
    ))) = 0 then
    raise exception 'verified orphan deletion guard missing';
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.article_revisions'::regclass
      and tgname = 'article_revisions_immutable'
      and not tgisinternal
  ) then
    raise exception 'article revisions are not protected as immutable snapshots';
  end if;
end;
$test$;

rollback;
