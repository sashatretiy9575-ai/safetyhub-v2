-- One-time, service-role-only import for the approved 25 August 2026 course
-- snapshot. The workflow is forward-only and phase-idempotent so a network
-- interruption can be retried without creating duplicate rows or objects.

create table private.initial_course_import_operations (
  id uuid primary key default gen_random_uuid(),
  project_ref text not null,
  catalog_hash text not null,
  payload_hash text,
  status text not null default 'begun',
  batch_id uuid unique references public.course_catalog_batches(id) on delete restrict,
  created_by uuid not null references auth.users(id) on delete restrict,
  pre_receipt jsonb not null,
  post_receipt jsonb,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  unique (project_ref, catalog_hash),
  constraint initial_course_import_project_ref_shape
    check (project_ref ~ '^[a-z0-9]{20}$'),
  constraint initial_course_import_catalog_hash_shape
    check (catalog_hash ~ '^[0-9a-f]{64}$'),
  constraint initial_course_import_payload_hash_shape
    check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  constraint initial_course_import_status
    check (status in ('begun', 'staged', 'prepared', 'activated', 'completed')),
  constraint initial_course_import_state check (
    (status = 'begun' and payload_hash is null and batch_id is null
      and post_receipt is null and completed_at is null)
    or (status = 'staged' and payload_hash is not null and batch_id is null
      and post_receipt is null and completed_at is null)
    or (status = 'prepared' and payload_hash is not null and batch_id is not null
      and post_receipt is null and completed_at is null)
    or (status = 'activated' and payload_hash is not null and batch_id is not null
      and post_receipt is not null and completed_at is null)
    or (status = 'completed' and payload_hash is not null and batch_id is not null
      and post_receipt is not null and completed_at is not null)
  )
);

create index initial_course_import_operations_status_idx
  on private.initial_course_import_operations(status, updated_at, id);

revoke all on private.initial_course_import_operations
  from public, anon, authenticated, service_role;

create function private.initial_import_expected_courses()
returns table (
  slug text,
  course_id uuid,
  presentation_id uuid,
  title text,
  display_order integer,
  content_hash text,
  pdf_sha256 text,
  thumbnail_sha256 text,
  byte_size bigint,
  page_count integer
)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('plotnik', 'f1d89c10-ca34-4223-8c04-de97790a3292'::uuid,
      'c1f45953-ef66-47cc-b2f8-93047fbfc648'::uuid, 'Плотник', 1,
      'deca2868066fc4bac15a20cac2cda38ae877451c34fff975e124be538cf6908e',
      '8a33e78a3f0546b3dd9af99500e1575ac1f6dae21c3a2dedd04e6e49e03c3ea8',
      '45c9230c47d6dfa212d7251c8e29cbb0cdd9308731a417560cba1d999b963205',
      1435334::bigint, 25),
    ('armaturshchik', 'edfaf13a-6111-4940-bc06-28d655c3001d'::uuid,
      '8e741453-9053-40d5-9a17-05e1136fd7b2'::uuid, 'Арматурщик', 2,
      '2f7a23db13eee141b55babca50e180de202ce60c7939e7aed771cd3d71f84585',
      'b76f7b404953629d78972bb197a8fb01c004741270f487ae492f2f5749684c32',
      '1e052a500d5722758671072877e0caea9ff6de665c60762f56f2e6eb86814a9c',
      2180188::bigint, 31),
    ('lesomontazhnye-raboty', '697acb0f-4761-4eef-bdd3-191939cf0afb'::uuid,
      'f7ef39ad-72c3-483e-8062-01beb02d4c42'::uuid, 'Лесомонтажные работы', 3,
      '2f260a510155afc0fb2bc20271deecd24b05afa6e68a7da13b68d3a90d9dcf01',
      '84034f4073330e9de1de1fd7cf4a12c25751435ab4ec6cac3251944e0500cf8e',
      '2bfa071fe4d833c0beb41f190393bd1a297445cf59d6c5d1b05359bc154fb764',
      1628986::bigint, 42),
    ('biot', '56c7fac7-7181-47e9-91cc-aa88e3c59191'::uuid,
      '9ece511d-f3b3-4209-bc7d-0429ba387684'::uuid, 'БИОТ', 4,
      '25d6cb6a6e881ee40d255dcf4374e5c384af2d255b6aa1a5cd3de29cbdb2ceb4',
      'a68cdfab938ab90cc8e847cd6fa5c0309c9caaa856795cbd70289eeb091afd9c',
      '99439358d73cbe9428b681beeeef39311b25b64d8c8dca85a169015393a3901c',
      1176614::bigint, 59),
    ('pozharnaya-bezopasnost', '5641b254-4aa5-4a8c-a7cf-4364a1de6db0'::uuid,
      '669596f1-7ce7-412d-97ad-a50c4c223cef'::uuid, 'Пожарная безопасность', 5,
      '68e9a7f2651ec2697385d880e910c5b5bac2b3f4d91fc1c50c732ef59cd853e9',
      '69f2e4cbe8d284996aa891862cf6228116cfda997775a7caa1d51bd9ee648eef',
      'f66043fa245ec4fa8511acad85397eb3fe26e48948c464f47e26b5408cacbbca',
      642302::bigint, 41)
  ) expected(
    slug, course_id, presentation_id, title, display_order, content_hash,
    pdf_sha256, thumbnail_sha256, byte_size, page_count
  );
$$;

revoke all on function private.initial_import_expected_courses()
  from public, anon, authenticated, service_role;

create function public.begin_initial_course_import(
  p_actor_id uuid,
  p_project_ref text,
  p_catalog_hash text,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.initial_course_import_operations%rowtype;
  v_pre_receipt jsonb;
  v_expected_hash constant text :=
    '11b5486025cbb94c02ea0ed021ce8a8afc3f1e4c997c9cccbf5497e8fb42c026';
begin
  if not private.actor_has_capability(p_actor_id, 'test.manage') then
    raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
  end if;
  if p_project_ref !~ '^[a-z0-9]{20}$'
    or p_catalog_hash is distinct from v_expected_hash
    or p_confirmation is distinct from
      'INITIAL-IMPORT:' || p_project_ref || ':' || p_catalog_hash then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INITIAL_IMPORT_CONFIRMATION_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('safetyhub:initial-course-import', 0));
  select * into v_operation
  from private.initial_course_import_operations operation
  where operation.project_ref = p_project_ref
    and operation.catalog_hash = p_catalog_hash
  for update;
  if found then
    if v_operation.created_by is distinct from p_actor_id then
      raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
    end if;
    return jsonb_build_object(
      'operationId', v_operation.id,
      'status', v_operation.status,
      'catalogHash', v_operation.catalog_hash,
      'batchId', v_operation.batch_id,
      'replayed', true
    );
  end if;

  if exists (select 1 from public.tests)
    or exists (select 1 from public.course_drafts)
    or exists (select 1 from public.test_revisions)
    or exists (select 1 from public.course_presentations)
    or exists (select 1 from public.course_catalog_batches)
    or exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates)
    or exists (select 1 from private.certificate_export_jobs) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_TARGET_NOT_EMPTY';
  end if;

  v_pre_receipt := jsonb_build_object(
    'catalogHash', p_catalog_hash,
    'catalog', jsonb_build_object('courses', 0, 'revisions', 0),
    'history', jsonb_build_object(
      'attempts', 0, 'attestations', 0, 'certificates', 0
    ),
    'accounts', jsonb_build_object(
      'authUsers', (select count(*) from auth.users),
      'profiles', (select count(*) from public.profiles)
    )
  );

  insert into private.initial_course_import_operations(
    project_ref, catalog_hash, created_by, pre_receipt
  ) values (p_project_ref, p_catalog_hash, p_actor_id, v_pre_receipt)
  returning * into v_operation;

  return jsonb_build_object(
    'operationId', v_operation.id,
    'status', v_operation.status,
    'catalogHash', v_operation.catalog_hash,
    'batchId', null,
    'replayed', false
  );
end;
$$;

create function public.stage_initial_course_import(
  p_operation_id uuid,
  p_catalog_hash text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.initial_course_import_operations%rowtype;
  v_course jsonb;
  v_expected record;
  v_payload_hash text;
  v_content_hash text;
  v_staging_prefix text;
  v_staging_pdf_path text;
  v_staging_thumbnail_path text;
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:initial-course-import', 0));
  select * into v_operation
  from private.initial_course_import_operations operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.catalog_hash is distinct from p_catalog_hash then
    raise exception using errcode = 'no_data_found', message = 'INITIAL_IMPORT_NOT_FOUND';
  end if;
  if not private.actor_has_capability(v_operation.created_by, 'test.manage') then
    raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
  end if;
  if p_payload ->> 'catalogHash' is distinct from v_operation.catalog_hash
    or p_payload ->> 'catalogVersion' is distinct from
      '2026-08-25-new-five-course-catalog'
    or (p_payload ->> 'schemaVersion')::integer is distinct from 1
    or jsonb_typeof(p_payload -> 'courses') is distinct from 'array'
    or jsonb_array_length(p_payload -> 'courses') <> 5 then
    raise exception using errcode = 'check_violation', message = 'INITIAL_IMPORT_PAYLOAD_INVALID';
  end if;

  v_payload_hash := encode(extensions.digest(
    convert_to(p_payload::text, 'utf8'), 'sha256'
  ), 'hex');
  if v_operation.payload_hash is not null
    and v_operation.payload_hash is distinct from v_payload_hash then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'INITIAL_IMPORT_PAYLOAD_CONFLICT';
  end if;
  if v_operation.status <> 'begun' then
    return jsonb_build_object(
      'operationId', v_operation.id,
      'status', v_operation.status,
      'payloadHash', v_operation.payload_hash,
      'batchId', v_operation.batch_id,
      'replayed', true
    );
  end if;
  if exists (select 1 from public.tests)
    or exists (select 1 from public.course_drafts)
    or exists (select 1 from public.test_revisions)
    or exists (select 1 from public.course_presentations)
    or exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_TARGET_NOT_EMPTY';
  end if;

  perform set_config('safetyhub.catalog_activation', '1', true);
  for v_course in
    select value from jsonb_array_elements(p_payload -> 'courses') item(value)
    order by (value ->> 'displayOrder')::integer
  loop
    select * into v_expected
    from private.initial_import_expected_courses() expected
    where expected.slug = v_course ->> 'slug';
    if not found
      or (v_course ->> 'id')::uuid is distinct from v_expected.course_id
      or (v_course -> 'presentation' ->> 'id')::uuid
        is distinct from v_expected.presentation_id
      or v_course ->> 'title' is distinct from v_expected.title
      or (v_course ->> 'displayOrder')::integer is distinct from v_expected.display_order
      or v_course ->> 'dbContentHash' is distinct from v_expected.content_hash
      or v_course -> 'presentation' ->> 'sha256' is distinct from v_expected.pdf_sha256
      or v_course -> 'presentation' ->> 'thumbnailSha256'
        is distinct from v_expected.thumbnail_sha256
      or (v_course -> 'presentation' ->> 'byteSize')::bigint
        is distinct from v_expected.byte_size
      or (v_course -> 'presentation' ->> 'pageCount')::integer
        is distinct from v_expected.page_count
      or (v_course -> 'policy' ->> 'durationMinutes')::integer <> 15
      or (v_course -> 'policy' ->> 'passScore')::integer <> 7
      or (v_course -> 'policy' ->> 'attemptsPerCalendarDay')::integer <> 8
      or v_course -> 'policy' ->> 'resetTimezone' <> 'Asia/Oral'
      or not private.course_question_variants_valid(v_course -> 'variants') then
      raise exception using errcode = 'check_violation',
        message = 'INITIAL_IMPORT_COURSE_INVALID:' || coalesce(v_course ->> 'slug', 'unknown');
    end if;

    v_content_hash := private.course_content_hash_v3(
      v_course ->> 'slug', v_course ->> 'title', v_course ->> 'description',
      v_course ->> 'icon', (v_course ->> 'displayOrder')::integer,
      v_expected.pdf_sha256, v_expected.page_count, 15, 7, 8, 'Asia/Oral',
      v_course -> 'variants', coalesce(v_course -> 'seo', '{}'::jsonb),
      nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb)
    );
    if v_content_hash is distinct from v_expected.content_hash then
      raise exception using errcode = 'check_violation',
        message = 'INITIAL_IMPORT_CONTENT_HASH_MISMATCH:' || v_expected.slug;
    end if;

    v_staging_prefix := 'initial-import/' || v_operation.id::text || '/'
      || v_expected.course_id::text || '/' || v_expected.presentation_id::text;
    v_staging_pdf_path := v_staging_prefix || '/source.pdf';
    v_staging_thumbnail_path := v_staging_prefix || '/thumbnail.webp';
    if not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'course-presentations-staging'
        and object.name = v_staging_pdf_path
    ) or not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'course-presentations-staging'
        and object.name = v_staging_thumbnail_path
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'INITIAL_IMPORT_STAGING_ASSET_MISSING:' || v_expected.slug;
    end if;

    insert into public.tests(
      id, slug, title, description, icon, display_order, seo, draft_content,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, status, jurisdiction, effective_date, sources,
      content_hash, created_by, updated_by
    ) values (
      v_expected.course_id, v_expected.slug, v_expected.title,
      coalesce(v_course ->> 'description', ''), v_course ->> 'icon',
      v_expected.display_order, coalesce(v_course -> 'seo', '{}'::jsonb),
      jsonb_build_object('questions', '[]'::jsonb, 'questionVariants', v_course -> 'variants'),
      15, 7, 8, 'Asia/Oral', 'draft', nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb), v_expected.content_hash,
      v_operation.created_by, v_operation.created_by
    );

    insert into public.course_presentations(
      id, course_id, storage_bucket, storage_path, thumbnail_path,
      source_filename, mime_type, byte_size, sha256, page_count, aspect_ratio,
      status, created_by
    ) values (
      v_expected.presentation_id, v_expected.course_id,
      'course-presentations-staging', v_staging_pdf_path, v_staging_thumbnail_path,
      'presentation.pdf', 'application/pdf', v_expected.byte_size,
      v_expected.pdf_sha256, v_expected.page_count, '16:9', 'staging',
      v_operation.created_by
    );

    insert into public.course_drafts(
      test_id, slug, title, description, icon, display_order, presentation_id,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, content, questions, question_variants, seo,
      jurisdiction, effective_date, sources, content_hash, updated_by
    ) values (
      v_expected.course_id, v_expected.slug, v_expected.title,
      coalesce(v_course ->> 'description', ''), v_course ->> 'icon',
      v_expected.display_order, v_expected.presentation_id, 15, 7, 8,
      'Asia/Oral', '{"modules":[]}'::jsonb, '[]'::jsonb,
      v_course -> 'variants', coalesce(v_course -> 'seo', '{}'::jsonb),
      nullif(v_course ->> 'jurisdiction', ''),
      nullif(v_course ->> 'effectiveDate', '')::date,
      coalesce(v_course -> 'sources', '[]'::jsonb), v_expected.content_hash,
      v_operation.created_by
    );
  end loop;

  if (select count(*) from public.tests) <> 5
    or (select count(*) from public.course_drafts) <> 5
    or (select count(*) from public.course_presentations) <> 5 then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'INITIAL_IMPORT_STAGE_POSTCONDITION_FAILED';
  end if;

  update private.initial_course_import_operations
  set payload_hash = v_payload_hash,
      status = 'staged',
      updated_at = statement_timestamp()
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'operationId', v_operation.id,
    'status', v_operation.status,
    'payloadHash', v_operation.payload_hash,
    'batchId', null,
    'replayed', false
  );
end;
$$;

create function public.prepare_initial_course_import(
  p_operation_id uuid,
  p_catalog_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.initial_course_import_operations%rowtype;
  v_expected record;
  v_batch_id uuid;
  v_public_pdf_path text;
  v_public_thumbnail_path text;
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:initial-course-import', 0));
  select * into v_operation
  from private.initial_course_import_operations operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.catalog_hash is distinct from p_catalog_hash then
    raise exception using errcode = 'no_data_found', message = 'INITIAL_IMPORT_NOT_FOUND';
  end if;
  if not private.actor_has_capability(v_operation.created_by, 'test.manage') then
    raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
  end if;
  if v_operation.status in ('prepared', 'activated', 'completed') then
    return jsonb_build_object(
      'operationId', v_operation.id,
      'status', v_operation.status,
      'batchId', v_operation.batch_id,
      'replayed', true
    );
  end if;
  if v_operation.status <> 'staged' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_NOT_STAGED';
  end if;

  perform set_config('safetyhub.catalog_activation', '1', true);
  for v_expected in select * from private.initial_import_expected_courses()
  loop
    v_public_pdf_path := v_expected.course_id::text || '/'
      || v_expected.presentation_id::text || '/' || v_expected.pdf_sha256 || '.pdf';
    v_public_thumbnail_path := v_expected.course_id::text || '/'
      || v_expected.presentation_id::text || '/' || v_expected.pdf_sha256 || '-thumb.webp';
    if not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'course-presentations' and object.name = v_public_pdf_path
    ) or not exists (
      select 1 from storage.objects object
      where object.bucket_id = 'course-presentations' and object.name = v_public_thumbnail_path
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'INITIAL_IMPORT_PUBLISHED_ASSET_MISSING:' || v_expected.slug;
    end if;

    update public.course_presentations presentation
    set storage_bucket = 'course-presentations',
        storage_path = v_public_pdf_path,
        thumbnail_path = v_public_thumbnail_path,
        status = 'ready',
        validated_at = statement_timestamp(),
        validation_error = null
    where presentation.id = v_expected.presentation_id
      and presentation.course_id = v_expected.course_id
      and presentation.status = 'staging'
      and presentation.sha256 = v_expected.pdf_sha256
      and presentation.byte_size = v_expected.byte_size
      and presentation.page_count = v_expected.page_count;
    if not found and not exists (
      select 1 from public.course_presentations presentation
      where presentation.id = v_expected.presentation_id
        and presentation.course_id = v_expected.course_id
        and presentation.status = 'ready'
        and presentation.storage_path = v_public_pdf_path
        and presentation.thumbnail_path = v_public_thumbnail_path
    ) then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'INITIAL_IMPORT_PRESENTATION_CONFLICT:' || v_expected.slug;
    end if;
  end loop;

  insert into public.course_catalog_batches(status, created_by)
  values ('staging', v_operation.created_by)
  returning id into v_batch_id;
  insert into public.course_catalog_batch_items(
    batch_id, test_id, display_order, expected_content_hash
  )
  select v_batch_id, expected.course_id, expected.display_order, expected.content_hash
  from private.initial_import_expected_courses() expected
  order by expected.display_order;

  if (select count(*) from public.course_catalog_batch_items item
      where item.batch_id = v_batch_id) <> 5
    or exists (
      select 1
      from private.initial_import_expected_courses() expected
      left join public.tests test on test.id = expected.course_id
      left join public.course_drafts draft on draft.test_id = expected.course_id
      left join public.course_presentations presentation
        on presentation.id = expected.presentation_id
      where test.status <> 'draft'
        or test.current_revision_id is not null
        or test.content_version <> 0
        or draft.content_hash is distinct from expected.content_hash
        or presentation.status <> 'ready'
    ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'INITIAL_IMPORT_BATCH_POSTCONDITION_FAILED';
  end if;

  update private.initial_course_import_operations
  set status = 'prepared',
      batch_id = v_batch_id,
      updated_at = statement_timestamp()
  where id = v_operation.id
  returning * into v_operation;

  return jsonb_build_object(
    'operationId', v_operation.id,
    'status', v_operation.status,
    'batchId', v_operation.batch_id,
    'replayed', false
  );
end;
$$;

create function public.activate_initial_course_import(
  p_operation_id uuid,
  p_catalog_hash text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.initial_course_import_operations%rowtype;
  v_item record;
  v_catalog_checksum text;
  v_post_receipt jsonb;
  v_result jsonb;
  v_courses integer;
  v_revisions integer;
  v_variants integer;
  v_questions integer;
  v_options integer;
begin
  if p_idempotency_key is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INITIAL_IMPORT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:initial-course-import', 0));
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:course-catalog-activation', 0));
  select * into v_operation
  from private.initial_course_import_operations operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.catalog_hash is distinct from p_catalog_hash then
    raise exception using errcode = 'no_data_found', message = 'INITIAL_IMPORT_NOT_FOUND';
  end if;
  if not private.actor_has_capability(v_operation.created_by, 'test.manage') then
    raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
  end if;
  if v_operation.status in ('activated', 'completed') then
    if not exists (
      select 1 from public.course_catalog_batches batch
      where batch.id = v_operation.batch_id
        and batch.activation_idempotency_key = p_idempotency_key
    ) then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_operation.post_receipt || jsonb_build_object(
      'operationId', v_operation.id,
      'status', v_operation.status,
      'batchId', v_operation.batch_id,
      'replayed', true
    );
  end if;
  if v_operation.status <> 'prepared' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_NOT_PREPARED';
  end if;
  if exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates)
    or (select count(*) from public.tests) <> 5
    or (select count(*) from public.test_revisions) <> 0 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_ACTIVATION_PRECONDITION_FAILED';
  end if;

  perform set_config('safetyhub.catalog_activation', '1', true);
  for v_item in
    select item.test_id, item.expected_content_hash
    from public.course_catalog_batch_items item
    where item.batch_id = v_operation.batch_id
    order by item.display_order
  loop
    perform private.publish_course_revision_v3_unmetered(
      v_operation.created_by, v_item.test_id, v_item.expected_content_hash
    );
  end loop;

  select count(*)::integer into v_courses
  from public.tests where status = 'published';
  select count(*)::integer into v_revisions
  from public.test_revisions revision
  join public.tests test on test.current_revision_id = revision.id
  where test.status = 'published';
  select count(*)::integer, coalesce(sum(variant.question_count), 0)::integer
  into v_variants, v_questions
  from public.test_revision_variants variant
  join public.tests test on test.current_revision_id = variant.revision_id
  where test.status = 'published';
  select count(*)::integer into v_options
  from public.test_revision_variants variant
  join public.tests test on test.current_revision_id = variant.revision_id
  cross join lateral jsonb_array_elements(variant.questions) question
  cross join lateral jsonb_array_elements(question -> 'options') option
  where test.status = 'published';
  select encode(extensions.digest(convert_to(string_agg(
    revision.content_hash, ',' order by revision.display_order
  ), 'utf8'), 'sha256'), 'hex')
  into v_catalog_checksum
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  where test.status = 'published';

  if (v_courses, v_revisions, v_variants, v_questions, v_options)
      is distinct from (5, 5, 15, 150, 600)
    or v_catalog_checksum is distinct from
      '9d34b6b4f106b6886a540e0b67c2f7be27ffa6b1e3e4656013e6192ed39c228a'
    or exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'INITIAL_IMPORT_ACTIVATION_POSTCONDITION_FAILED';
  end if;

  v_post_receipt := jsonb_build_object(
    'catalogHash', v_operation.catalog_hash,
    'catalogChecksum', v_catalog_checksum,
    'published', jsonb_build_object(
      'courses', v_courses, 'revisions', v_revisions, 'variants', v_variants,
      'questions', v_questions, 'options', v_options
    ),
    'history', jsonb_build_object(
      'attempts', 0, 'attestations', 0, 'certificates', 0
    )
  );
  v_result := v_post_receipt || jsonb_build_object(
    'operationId', v_operation.id,
    'status', 'activated',
    'batchId', v_operation.batch_id,
    'replayed', false
  );

  update public.course_catalog_batches
  set status = 'activated',
      activation_idempotency_key = p_idempotency_key,
      result = v_result,
      activated_at = statement_timestamp()
  where id = v_operation.batch_id and status = 'staging';
  if not found then
    raise exception using errcode = 'serialization_failure',
      message = 'INITIAL_IMPORT_BATCH_CONFLICT';
  end if;

  update private.initial_course_import_operations
  set status = 'activated',
      post_receipt = v_post_receipt,
      updated_at = statement_timestamp()
  where id = v_operation.id;

  insert into public.admin_audit_log(
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_operation.created_by, 'catalog.initial_import_activated',
    'course_catalog_batch', v_operation.batch_id::text,
    v_post_receipt, v_operation.batch_id
  );
  return v_result;
end;
$$;

create function public.complete_initial_course_import(
  p_operation_id uuid,
  p_catalog_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.initial_course_import_operations%rowtype;
  v_expected record;
  v_prefix text;
begin
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:initial-course-import', 0));
  select * into v_operation
  from private.initial_course_import_operations operation
  where operation.id = p_operation_id
  for update;
  if not found or v_operation.catalog_hash is distinct from p_catalog_hash then
    raise exception using errcode = 'no_data_found', message = 'INITIAL_IMPORT_NOT_FOUND';
  end if;
  if v_operation.status = 'completed' then
    return v_operation.post_receipt || jsonb_build_object(
      'operationId', v_operation.id,
      'status', 'completed',
      'batchId', v_operation.batch_id,
      'replayed', true
    );
  end if;
  if v_operation.status <> 'activated' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'INITIAL_IMPORT_NOT_ACTIVATED';
  end if;
  for v_expected in select * from private.initial_import_expected_courses()
  loop
    v_prefix := 'initial-import/' || v_operation.id::text || '/'
      || v_expected.course_id::text || '/' || v_expected.presentation_id::text;
    if exists (
      select 1 from storage.objects object
      where object.bucket_id = 'course-presentations-staging'
        and object.name in (v_prefix || '/source.pdf', v_prefix || '/thumbnail.webp')
    ) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'INITIAL_IMPORT_STAGING_CLEANUP_PENDING';
    end if;
  end loop;
  update private.initial_course_import_operations
  set status = 'completed',
      updated_at = statement_timestamp(),
      completed_at = statement_timestamp()
  where id = v_operation.id
  returning * into v_operation;
  return v_operation.post_receipt || jsonb_build_object(
    'operationId', v_operation.id,
    'status', 'completed',
    'batchId', v_operation.batch_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.begin_initial_course_import(uuid,text,text,text),
  public.stage_initial_course_import(uuid,text,jsonb),
  public.prepare_initial_course_import(uuid,text),
  public.activate_initial_course_import(uuid,text,uuid),
  public.complete_initial_course_import(uuid,text)
from public, anon, authenticated, service_role;
grant execute on function public.begin_initial_course_import(uuid,text,text,text),
  public.stage_initial_course_import(uuid,text,jsonb),
  public.prepare_initial_course_import(uuid,text),
  public.activate_initial_course_import(uuid,text,uuid),
  public.complete_initial_course_import(uuid,text)
to service_role;

comment on table private.initial_course_import_operations is
  'Server-only phase receipt for the approved empty-project course import; contains no answer keys or personal data.';
comment on function public.begin_initial_course_import(uuid,text,text,text) is
  'Service-role-only initial course import preflight with exact project/hash confirmation.';
