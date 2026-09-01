-- Additive multilingual content storage. The existing Russian columns remain
-- available until every application read/write path has moved to locale rows.

create function private.localized_questions_valid(p_questions jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_question jsonb;
  v_option jsonb;
  v_question_count integer;
  v_option_count integer;
begin
  if jsonb_typeof(p_questions) is distinct from 'array'
    or pg_column_size(p_questions) > 524288 then
    return false;
  end if;
  v_question_count := jsonb_array_length(p_questions);
  if v_question_count not between 1 and 100 then
    return false;
  end if;
  for v_question in select value from jsonb_array_elements(p_questions)
  loop
    if jsonb_typeof(v_question) is distinct from 'object'
      or coalesce(v_question ->> 'id', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or char_length(coalesce(v_question ->> 'text', '')) not between 1 and 2000
      or v_question ? 'correctOptionId'
      or v_question ? 'correct_option_id'
      or jsonb_typeof(v_question -> 'options') is distinct from 'array' then
      return false;
    end if;
    v_option_count := jsonb_array_length(v_question -> 'options');
    if v_option_count not between 2 and 10 then
      return false;
    end if;
    for v_option in select value from jsonb_array_elements(v_question -> 'options')
    loop
      if jsonb_typeof(v_option) is distinct from 'object'
        or coalesce(v_option ->> 'id', '')
          !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or char_length(coalesce(v_option ->> 'text', '')) not between 1 and 2000
        or v_option ? 'correct'
        or v_option ? 'isCorrect' then
        return false;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

create function private.assessment_structure(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', question.value ->> 'id',
      'position', question.ordinality,
      'options', (
        select coalesce(jsonb_agg(
          jsonb_build_object(
            'id', option.value ->> 'id',
            'position', option.ordinality
          ) order by option.ordinality
        ), '[]'::jsonb)
        from jsonb_array_elements(question.value -> 'options')
          with ordinality option(value, ordinality)
      )
    ) order by question.ordinality
  ), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality)
$$;

create function private.assessment_structure_hash(p_questions jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(private.assessment_structure(p_questions)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function private.localized_variants_from_source(p_variants jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', variant.value ->> 'id',
      'variantNumber', (variant.value ->> 'variantNumber')::integer,
      'questions', private.public_questions_from_draft(variant.value -> 'questions')
    ) order by (variant.value ->> 'variantNumber')::integer
  ), '[]'::jsonb)
  from jsonb_array_elements(p_variants) variant(value)
$$;

create table public.course_draft_localizations (
  test_id uuid not null references public.course_drafts(test_id) on delete cascade,
  locale public.app_locale not null,
  title text not null,
  description text not null default '',
  content jsonb not null default '{"modules":[]}'::jsonb,
  question_variants jsonb not null default '[]'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null,
  reviewed_content_hash text,
  translation_qa jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  draft_version bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (test_id, locale),
  constraint course_draft_localization_title_budget
    check (char_length(title) between 1 and 200),
  constraint course_draft_localization_description_budget
    check (char_length(description) <= 2000),
  constraint course_draft_localization_content_budget
    check (
      jsonb_typeof(content) = 'object'
      and pg_column_size(content) <= 524288
    ),
  constraint course_draft_localization_variants_budget
    check (
      jsonb_typeof(question_variants) = 'array'
      and jsonb_array_length(question_variants) <= 3
      and pg_column_size(question_variants) <= 1048576
    ),
  constraint course_draft_localization_seo_budget
    check (jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768),
  constraint course_draft_localization_sources_budget
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 131072),
  constraint course_draft_localization_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint course_draft_localization_reviewed_hash_shape
    check (reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'),
  constraint course_draft_localization_qa_budget
    check (jsonb_typeof(translation_qa) = 'object' and pg_column_size(translation_qa) <= 65536),
  constraint course_draft_localization_status
    check (status in ('missing', 'draft', 'complete')),
  constraint course_draft_localization_version_positive check (draft_version > 0)
);

create table public.test_revision_localizations (
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  locale public.app_locale not null,
  title text not null,
  description text not null default '',
  content jsonb not null default '{"modules":[]}'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null,
  translation_qa jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default statement_timestamp(),
  published_by uuid references auth.users(id) on delete set null,
  primary key (revision_id, locale),
  constraint test_revision_localization_title_budget
    check (char_length(title) between 1 and 200),
  constraint test_revision_localization_description_budget
    check (char_length(description) <= 2000),
  constraint test_revision_localization_content_budget
    check (jsonb_typeof(content) = 'object' and pg_column_size(content) <= 524288),
  constraint test_revision_localization_seo_budget
    check (jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768),
  constraint test_revision_localization_sources_budget
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 131072),
  constraint test_revision_localization_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint test_revision_localization_qa_budget
    check (jsonb_typeof(translation_qa) = 'object' and pg_column_size(translation_qa) <= 65536)
);

create table public.test_revision_variant_localizations (
  revision_id uuid not null,
  variant_id uuid not null,
  locale public.app_locale not null,
  questions jsonb not null,
  explanations jsonb not null default '[]'::jsonb,
  question_count smallint not null,
  structure_hash text not null,
  content_hash text not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (variant_id, locale),
  foreign key (revision_id, variant_id)
    references public.test_revision_variants(revision_id, id) on delete cascade,
  constraint test_revision_variant_localization_question_count
    check (question_count between 1 and 100),
  constraint test_revision_variant_localization_questions_shape
    check (
      jsonb_array_length(questions) = question_count
      and private.localized_questions_valid(questions)
    ),
  constraint test_revision_variant_localization_explanations_shape
    check (
      jsonb_typeof(explanations) = 'array'
      and jsonb_array_length(explanations) = question_count
      and pg_column_size(explanations) <= 131072
    ),
  constraint test_revision_variant_localization_structure_hash
    check (
      structure_hash ~ '^[0-9a-f]{64}$'
      and structure_hash = private.assessment_structure_hash(questions)
    ),
  constraint test_revision_variant_localization_content_hash
    check (content_hash ~ '^[0-9a-f]{64}$')
);

create index test_revision_variant_localizations_revision_locale_idx
  on public.test_revision_variant_localizations (revision_id, locale, variant_id);

create table public.article_draft_localizations (
  article_id uuid not null references public.article_drafts(article_id) on delete cascade,
  locale public.app_locale not null,
  title text not null,
  description text not null default '',
  blocks jsonb not null default '[]'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null,
  reviewed_content_hash text,
  translation_qa jsonb not null default '{}'::jsonb,
  status text not null default 'draft',
  draft_version bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (article_id, locale),
  constraint article_draft_localization_title_budget
    check (char_length(title) between 1 and 200),
  constraint article_draft_localization_description_budget
    check (char_length(description) <= 2000),
  constraint article_draft_localization_blocks_budget
    check (
      jsonb_typeof(blocks) = 'array'
      and jsonb_array_length(blocks) <= 100
      and pg_column_size(blocks) <= 262144
    ),
  constraint article_draft_localization_seo_budget
    check (jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768),
  constraint article_draft_localization_sources_budget
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 131072),
  constraint article_draft_localization_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_draft_localization_reviewed_hash_shape
    check (reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_draft_localization_qa_budget
    check (jsonb_typeof(translation_qa) = 'object' and pg_column_size(translation_qa) <= 65536),
  constraint article_draft_localization_status
    check (status in ('missing', 'draft', 'complete')),
  constraint article_draft_localization_version_positive check (draft_version > 0)
);

create table public.article_revision_localizations (
  revision_id uuid not null references public.article_revisions(id) on delete cascade,
  locale public.app_locale not null,
  title text not null,
  description text not null default '',
  blocks jsonb not null,
  seo jsonb not null default '{}'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null,
  translation_qa jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default statement_timestamp(),
  published_by uuid references auth.users(id) on delete set null,
  primary key (revision_id, locale),
  constraint article_revision_localization_title_budget
    check (char_length(title) between 1 and 200),
  constraint article_revision_localization_description_budget
    check (char_length(description) <= 2000),
  constraint article_revision_localization_blocks_budget
    check (
      jsonb_typeof(blocks) = 'array'
      and jsonb_array_length(blocks) <= 100
      and pg_column_size(blocks) <= 262144
    ),
  constraint article_revision_localization_seo_budget
    check (jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768),
  constraint article_revision_localization_sources_budget
    check (jsonb_typeof(sources) = 'array' and pg_column_size(sources) <= 131072),
  constraint article_revision_localization_hash_shape
    check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_revision_localization_qa_budget
    check (jsonb_typeof(translation_qa) = 'object' and pg_column_size(translation_qa) <= 65536)
);

alter table public.course_presentations
  add column locale public.app_locale not null default 'ru';

alter table public.course_presentations
  drop constraint course_presentation_ready_immutable_path,
  add constraint course_presentation_ready_immutable_path check (
    status <> 'ready'
    or (
      (
        storage_path = course_id::text || '/' || locale::text || '/'
          || id::text || '/' || sha256 || '.pdf'
        and thumbnail_path = course_id::text || '/' || locale::text || '/'
          || id::text || '/' || sha256 || '-thumb.webp'
      )
      or (
        locale = 'ru'
        and storage_path = course_id::text || '/' || id::text || '/'
          || sha256 || '.pdf'
        and thumbnail_path = course_id::text || '/' || id::text || '/'
          || sha256 || '-thumb.webp'
      )
    )
  );

drop index if exists public.course_presentations_ready_hash_idx;
create unique index course_presentations_ready_locale_hash_idx
  on public.course_presentations(course_id, locale, sha256)
  where status = 'ready';

-- Finalization keeps the established service-only signature. The locale is
-- trusted only from the presentation metadata row after it has been locked;
-- callers cannot redirect an upload into another locale by changing a
-- request parameter.
create or replace function public.finalize_course_presentation_metadata(
  p_actor_id uuid,
  p_course_id uuid,
  p_presentation_id uuid,
  p_expected_sha256 text,
  p_expected_page_count integer,
  p_expected_byte_size bigint,
  p_expected_staging_pdf_path text,
  p_expected_staging_thumbnail_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_presentation public.course_presentations%rowtype;
  v_cleanup public.course_presentations%rowtype;
  v_sha256 text := lower(coalesce(p_expected_sha256, ''));
  v_public_pdf_path text;
  v_public_thumbnail_path text;
  v_legacy_pdf_path text;
  v_legacy_thumbnail_path text;
  v_staging_prefix text;
  v_now timestamptz := statement_timestamp();
begin
  begin
    if not private.actor_has_capability(p_actor_id, 'test.manage') then
      raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
    end if;
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    if private.course_catalog_maintenance_enabled() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_CATALOG_MAINTENANCE';
    end if;
    if p_course_id is null or p_presentation_id is null
      or v_sha256 !~ '^[0-9a-f]{64}$'
      or p_expected_page_count not between 1 and 200
      or p_expected_byte_size not between 1 and 26214400
      or char_length(coalesce(p_expected_staging_pdf_path, '')) not between 1 and 1024
      or char_length(coalesce(p_expected_staging_thumbnail_path, '')) not between 1 and 1024 then
      raise exception using errcode = 'invalid_parameter_value',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;
    v_staging_prefix := regexp_replace(
      p_expected_staging_pdf_path, '/source[.]pdf$', ''
    );
    if v_staging_prefix = p_expected_staging_pdf_path
      or p_expected_staging_thumbnail_path
        is distinct from v_staging_prefix || '/thumbnail.webp'
      or p_expected_staging_pdf_path
        !~ ('^' || p_actor_id::text
          || '/[0-9a-f-]{36}/source[.]pdf$') then
      raise exception using errcode = 'check_violation',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;

    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = p_presentation_id
    for update;
    if not found
      or v_presentation.course_id is distinct from p_course_id
      or v_presentation.created_by is distinct from p_actor_id
      or v_presentation.sha256 is distinct from v_sha256
      or v_presentation.page_count is distinct from p_expected_page_count
      or v_presentation.byte_size is distinct from p_expected_byte_size then
      raise exception using errcode = 'check_violation',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;

    v_public_pdf_path := p_course_id::text || '/'
      || v_presentation.locale::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '.pdf';
    v_public_thumbnail_path := p_course_id::text || '/'
      || v_presentation.locale::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '-thumb.webp';
    v_legacy_pdf_path := p_course_id::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '.pdf';
    v_legacy_thumbnail_path := p_course_id::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '-thumb.webp';

    if not exists (
      select 1 from public.tests test
      join public.course_drafts draft on draft.test_id = test.id
      where test.id = p_course_id
    ) then
      raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
    end if;

    if v_presentation.status = 'ready' then
      if v_presentation.storage_bucket <> 'course-presentations'
        or not (
          (
            v_presentation.storage_path = v_public_pdf_path
            and v_presentation.thumbnail_path = v_public_thumbnail_path
          )
          or (
            v_presentation.locale = 'ru'
            and v_presentation.storage_path = v_legacy_pdf_path
            and v_presentation.thumbnail_path = v_legacy_thumbnail_path
          )
        ) then
        raise exception using errcode = 'integrity_constraint_violation',
          message = 'PRESENTATION_VALIDATION_FAILED';
      end if;
      select * into v_cleanup
      from public.course_presentations cleanup
      where cleanup.storage_bucket = 'course-presentations-staging'
        and cleanup.storage_path = p_expected_staging_pdf_path
        and cleanup.locale = v_presentation.locale
        and cleanup.status = 'retired'
      limit 1;
      return private.ensure_rpc_payload(jsonb_build_object(
        'presentation', jsonb_build_object(
          'id', v_presentation.id,
          'courseId', v_presentation.course_id,
          'locale', v_presentation.locale,
          'storageBucket', v_presentation.storage_bucket,
          'storagePath', v_presentation.storage_path,
          'thumbnailPath', v_presentation.thumbnail_path,
          'sha256', v_presentation.sha256,
          'pageCount', v_presentation.page_count,
          'byteSize', v_presentation.byte_size,
          'status', v_presentation.status,
          'validatedAt', v_presentation.validated_at
        ),
        'cleanup', case when v_cleanup.id is null then null else jsonb_build_object(
          'id', v_cleanup.id,
          'locale', v_cleanup.locale,
          'bucket', v_cleanup.storage_bucket,
          'path', v_cleanup.storage_path,
          'thumbnailPath', v_cleanup.thumbnail_path,
          'leaseExpiresAt', v_cleanup.cleanup_claimed_at + interval '10 minutes'
        ) end,
        'replayed', true
      ));
    end if;

    if v_presentation.status <> 'validating'
      or v_presentation.storage_bucket <> 'course-presentations-staging'
      or v_presentation.storage_path <> p_expected_staging_pdf_path
      or v_presentation.thumbnail_path <> p_expected_staging_thumbnail_path then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'PRESENTATION_NOT_READY';
    end if;

    update public.course_presentations
    set storage_bucket = 'course-presentations',
        storage_path = v_public_pdf_path,
        thumbnail_path = v_public_thumbnail_path,
        status = 'ready',
        validation_error = null,
        validated_at = v_now,
        retired_at = null,
        cleanup_claimed_at = null
    where id = v_presentation.id
    returning * into v_presentation;

    insert into public.course_presentations(
      course_id, locale, storage_bucket, storage_path, thumbnail_path,
      source_filename, mime_type, byte_size, sha256, page_count,
      aspect_ratio, status, created_by, created_at, retired_at,
      cleanup_claimed_at
    ) values (
      p_course_id, v_presentation.locale, 'course-presentations-staging',
      p_expected_staging_pdf_path, p_expected_staging_thumbnail_path,
      v_presentation.source_filename, 'application/pdf',
      v_presentation.byte_size, v_presentation.sha256,
      v_presentation.page_count, v_presentation.aspect_ratio,
      'retired', p_actor_id, v_now, v_now, v_now
    ) returning * into v_cleanup;

    insert into public.admin_audit_log(
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      p_actor_id, 'course.presentation_finalized', 'course_presentation',
      v_presentation.id::text,
      jsonb_build_object(
        'courseId', p_course_id,
        'locale', v_presentation.locale,
        'sha256', v_presentation.sha256,
        'pageCount', v_presentation.page_count,
        'byteSize', v_presentation.byte_size,
        'cleanupId', v_cleanup.id
      )
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'presentation', jsonb_build_object(
        'id', v_presentation.id,
        'courseId', v_presentation.course_id,
        'locale', v_presentation.locale,
        'storageBucket', v_presentation.storage_bucket,
        'storagePath', v_presentation.storage_path,
        'thumbnailPath', v_presentation.thumbnail_path,
        'sha256', v_presentation.sha256,
        'pageCount', v_presentation.page_count,
        'byteSize', v_presentation.byte_size,
        'status', v_presentation.status,
        'validatedAt', v_presentation.validated_at
      ),
      'cleanup', jsonb_build_object(
        'id', v_cleanup.id,
        'locale', v_cleanup.locale,
        'bucket', v_cleanup.storage_bucket,
        'path', v_cleanup.storage_path,
        'thumbnailPath', v_cleanup.thumbnail_path,
        'leaseExpiresAt', v_cleanup.cleanup_claimed_at + interval '10 minutes'
      ),
      'replayed', false
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.finalize_course_presentation_metadata(
  uuid,uuid,uuid,text,integer,bigint,text,text
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_course_presentation_metadata(
  uuid,uuid,uuid,text,integer,bigint,text,text
) to service_role;

create table public.course_draft_presentations (
  test_id uuid not null references public.course_drafts(test_id) on delete cascade,
  locale public.app_locale not null,
  presentation_id uuid not null references public.course_presentations(id) on delete restrict,
  primary key (test_id, locale),
  unique (presentation_id)
);

create table public.test_revision_presentations (
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  locale public.app_locale not null,
  presentation_id uuid not null references public.course_presentations(id) on delete restrict,
  created_at timestamptz not null default statement_timestamp(),
  primary key (revision_id, locale)
);

create index test_revision_presentations_presentation_idx
  on public.test_revision_presentations (presentation_id, revision_id, locale);

insert into public.course_draft_localizations (
  test_id, locale, title, description, content, question_variants, seo, sources,
  content_hash, reviewed_content_hash, translation_qa, status, draft_version,
  updated_by, created_at, updated_at
)
select
  draft.test_id, 'ru', draft.title, draft.description, draft.content,
  private.localized_variants_from_source(draft.question_variants),
  draft.seo, draft.sources, draft.content_hash,
  draft.content_hash,
  jsonb_build_object('mode', 'source', 'locale', 'ru'),
  'complete',
  draft.draft_version, draft.updated_by, draft.created_at, draft.updated_at
from public.course_drafts draft
on conflict (test_id, locale) do nothing;

insert into public.test_revision_localizations (
  revision_id, locale, title, description, content, seo, sources, content_hash,
  translation_qa, published_at, published_by
)
select
  revision.id, 'ru', revision.title, revision.description, revision.content,
  revision.seo, revision.sources, revision.content_hash,
  jsonb_build_object('mode', 'source', 'locale', 'ru'),
  revision.published_at, revision.published_by
from public.test_revisions revision
on conflict (revision_id, locale) do nothing;

insert into public.test_revision_variant_localizations (
  revision_id, variant_id, locale, questions, explanations, question_count,
  structure_hash, content_hash
)
select
  variant.revision_id,
  variant.id,
  'ru',
  variant.questions,
  answer_key.explanations,
  variant.question_count,
  private.assessment_structure_hash(variant.questions),
  encode(extensions.digest(convert_to(variant.questions::text, 'UTF8'), 'sha256'), 'hex')
from public.test_revision_variants variant
join private.test_revision_variant_answer_keys answer_key
  on answer_key.revision_id = variant.revision_id
 and answer_key.variant_id = variant.id
where private.localized_questions_valid(variant.questions)
on conflict (variant_id, locale) do nothing;

insert into public.article_draft_localizations (
  article_id, locale, title, description, blocks, seo, sources, content_hash,
  reviewed_content_hash, translation_qa, status, draft_version, updated_by,
  created_at, updated_at
)
select
  draft.article_id, 'ru', draft.title, draft.description, draft.blocks,
  draft.seo, draft.sources, draft.content_hash, draft.content_hash,
  jsonb_build_object('mode', 'source', 'locale', 'ru'),
  'complete',
  draft.draft_version, draft.updated_by, draft.created_at, draft.updated_at
from public.article_drafts draft
on conflict (article_id, locale) do nothing;

insert into public.article_revision_localizations (
  revision_id, locale, title, description, blocks, seo, sources, content_hash,
  translation_qa, published_at, published_by
)
select
  revision.id, 'ru', revision.title, revision.description, revision.blocks,
  revision.seo, revision.sources, revision.content_hash,
  jsonb_build_object('mode', 'source', 'locale', 'ru'),
  revision.published_at, revision.published_by
from public.article_revisions revision
on conflict (revision_id, locale) do nothing;

insert into public.course_draft_presentations (test_id, locale, presentation_id)
select draft.test_id, 'ru', draft.presentation_id
from public.course_drafts draft
where draft.presentation_id is not null
on conflict (test_id, locale) do nothing;

insert into public.test_revision_presentations (revision_id, locale, presentation_id)
select revision.id, 'ru', revision.presentation_id
from public.test_revisions revision
where revision.presentation_id is not null
on conflict (revision_id, locale) do nothing;

create function private.protect_published_localization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('safetyhub.content_delete', true), '') = '1' then
    return old;
  end if;
  raise exception using errcode = 'object_in_use',
    message = 'PUBLISHED_LOCALIZATION_IMMUTABLE';
end;
$$;

create trigger test_revision_localizations_immutable
before update or delete on public.test_revision_localizations
for each row execute function private.protect_published_localization();
create trigger test_revision_variant_localizations_immutable
before update or delete on public.test_revision_variant_localizations
for each row execute function private.protect_published_localization();
create trigger article_revision_localizations_immutable
before update or delete on public.article_revision_localizations
for each row execute function private.protect_published_localization();
create trigger test_revision_presentations_immutable
before update or delete on public.test_revision_presentations
for each row execute function private.protect_published_localization();

create function private.protect_ready_presentation_locale()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('ready', 'retired') and new.locale is distinct from old.locale then
    raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
  end if;
  return new;
end;
$$;

create trigger course_presentations_locale_immutable
before update on public.course_presentations
for each row execute function private.protect_ready_presentation_locale();

create trigger course_draft_localizations_set_updated_at
before update on public.course_draft_localizations
for each row execute function private.set_updated_at();
create trigger article_draft_localizations_set_updated_at
before update on public.article_draft_localizations
for each row execute function private.set_updated_at();

alter table public.course_draft_localizations enable row level security;
alter table public.test_revision_localizations enable row level security;
alter table public.test_revision_variant_localizations enable row level security;
alter table public.article_draft_localizations enable row level security;
alter table public.article_revision_localizations enable row level security;
alter table public.course_draft_presentations enable row level security;
alter table public.test_revision_presentations enable row level security;

revoke all on public.course_draft_localizations,
  public.test_revision_localizations,
  public.test_revision_variant_localizations,
  public.article_draft_localizations,
  public.article_revision_localizations,
  public.course_draft_presentations,
  public.test_revision_presentations
from public, anon, authenticated;

grant select, insert, update, delete on public.course_draft_localizations,
  public.test_revision_localizations,
  public.test_revision_variant_localizations,
  public.article_draft_localizations,
  public.article_revision_localizations,
  public.course_draft_presentations,
  public.test_revision_presentations
to service_role;

revoke all on function private.localized_questions_valid(jsonb),
  private.assessment_structure(jsonb),
  private.assessment_structure_hash(jsonb),
  private.localized_variants_from_source(jsonb),
  private.protect_published_localization(),
  private.protect_ready_presentation_locale()
from public, anon, authenticated, service_role;

comment on table public.test_revision_variant_localizations is
  'Localized question and option text only. Correct option IDs remain in private answer-key tables.';
comment on table public.test_revision_presentations is
  'Exactly one immutable published presentation reference per revision and locale.';
