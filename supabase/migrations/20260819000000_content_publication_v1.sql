-- SafetyHub CMS v1: keep editable drafts separate from immutable public projections.
-- The migration is additive so the previous application can continue reading the
-- existing public tables during a deployment rollback.

alter table public.tests
  add column if not exists icon text not null default 'factory',
  add column if not exists seo jsonb not null default '{}'::jsonb;

alter table public.test_revisions
  add column if not exists icon text not null default 'factory',
  add column if not exists content jsonb not null default '{"modules":[]}'::jsonb,
  add column if not exists seo jsonb not null default '{}'::jsonb,
  add column if not exists content_hash text not null default repeat('0', 64),
  add column if not exists jurisdiction text,
  add column if not exists effective_date date,
  add column if not exists reviewer text,
  add column if not exists reviewed_at timestamptz,
  add column if not exists next_review_at timestamptz,
  add column if not exists sources jsonb not null default '[]'::jsonb;

alter table public.articles
  add column if not exists seo jsonb not null default '{}'::jsonb;

create table public.course_drafts (
  test_id uuid primary key references public.tests(id) on delete cascade,
  slug text not null unique,
  title text not null,
  description text not null default '',
  icon text not null default 'factory',
  duration_minutes integer not null default 5,
  pass_score integer not null default 4,
  content jsonb not null default '{"modules":[]}'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  jurisdiction text,
  effective_date date,
  reviewer text,
  reviewed_at timestamptz,
  next_review_at timestamptz,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null default repeat('0', 64),
  reviewed_content_hash text,
  draft_version bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint course_draft_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint course_draft_title_budget check (char_length(title) between 3 and 200),
  constraint course_draft_duration check (duration_minutes between 1 and 120),
  constraint course_draft_pass_score check (pass_score between 1 and 100),
  constraint course_draft_content_shape check (
    jsonb_typeof(content) = 'object'
    and jsonb_typeof(content -> 'modules') = 'array'
    and jsonb_array_length(content -> 'modules') between 1 and 50
    and pg_column_size(content) <= 524288
  ),
  constraint course_draft_questions_shape check (
    jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) = 5
    and pg_column_size(questions) <= 262144
  ),
  constraint course_draft_seo_shape check (
    jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768
  ),
  constraint course_draft_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint course_draft_reviewed_hash_shape check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'
  )
);

create table public.course_slug_redirects (
  old_slug text primary key,
  test_id uuid not null references public.tests(id) on delete cascade,
  created_at timestamptz not null default statement_timestamp(),
  constraint course_redirect_slug_shape check (old_slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

create table public.article_drafts (
  article_id uuid primary key references public.articles(id) on delete cascade,
  slug text not null unique,
  title text not null,
  description text not null default '',
  cover_image text not null default '',
  blocks jsonb not null default '[]'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  jurisdiction text,
  effective_date date,
  reviewer text,
  reviewed_at timestamptz,
  next_review_at timestamptz,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null default repeat('0', 64),
  reviewed_content_hash text,
  draft_version bigint not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint article_draft_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint article_draft_title_budget check (char_length(title) between 3 and 200),
  constraint article_draft_blocks_budget check (
    jsonb_typeof(blocks) = 'array'
    and jsonb_array_length(blocks) <= 100
    and pg_column_size(blocks) <= 131072
  ),
  constraint article_draft_seo_shape check (
    jsonb_typeof(seo) = 'object' and pg_column_size(seo) <= 32768
  ),
  constraint article_draft_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_draft_reviewed_hash_shape check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'
  )
);

create table public.article_revisions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  version integer not null,
  slug text not null,
  title text not null,
  description text not null default '',
  cover_image text not null default '',
  blocks jsonb not null,
  seo jsonb not null default '{}'::jsonb,
  jurisdiction text,
  effective_date date,
  reviewer text,
  reviewed_at timestamptz,
  next_review_at timestamptz,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null,
  published_at timestamptz not null default statement_timestamp(),
  published_by uuid references auth.users(id) on delete set null,
  unique(article_id, version),
  constraint article_revision_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint article_revision_blocks_budget check (
    jsonb_typeof(blocks) = 'array'
    and jsonb_array_length(blocks) <= 100
    and pg_column_size(blocks) <= 131072
  ),
  constraint article_revision_hash_shape check (content_hash ~ '^[0-9a-f]{64}$')
);

alter table public.articles
  add column if not exists current_revision_id uuid references public.article_revisions(id) on delete set null,
  add column if not exists content_version integer not null default 0;

create table public.content_assets (
  id uuid primary key default gen_random_uuid(),
  storage_key text not null unique,
  mime_type text not null,
  width integer not null,
  height integer not null,
  byte_size integer not null,
  sha256 text not null unique,
  original_filename text not null,
  status text not null default 'active',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  last_referenced_at timestamptz,
  constraint content_asset_key_shape check (storage_key ~ '^[0-9a-f]{2}/[0-9a-f]{64}[.]webp$'),
  constraint content_asset_mime check (mime_type = 'image/webp'),
  constraint content_asset_dimensions check (width between 1 and 1600 and height between 1 and 1600),
  constraint content_asset_size check (byte_size between 1 and 2097152),
  constraint content_asset_hash_shape check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint content_asset_status check (status in ('active', 'orphan_candidate', 'delete_pending'))
);

create table public.content_asset_usages (
  asset_id uuid not null references public.content_assets(id) on delete restrict,
  owner_type text not null,
  owner_id uuid not null,
  owner_version integer not null default 0,
  usage_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (asset_id, owner_type, owner_id, owner_version, usage_key),
  constraint content_asset_owner_type check (owner_type in ('course_draft', 'course_revision', 'article_draft', 'article_revision')),
  constraint content_asset_usage_key_budget check (char_length(usage_key) between 1 and 200)
);

create index content_asset_usages_owner_idx
  on public.content_asset_usages(owner_type, owner_id, owner_version);

insert into public.course_drafts (
  test_id, slug, title, description, icon, duration_minutes, pass_score,
  content, questions, seo, jurisdiction, effective_date, reviewer, reviewed_at,
  next_review_at, sources, content_hash, reviewed_content_hash, updated_by,
  created_at, updated_at
)
select
  test.id, test.slug, test.title, test.description, 'factory',
  test.duration_minutes, test.pass_score,
  jsonb_build_object('modules', jsonb_build_array(jsonb_build_object(
    'id', 'module-main', 'title', test.title,
    'lessons', jsonb_build_array(jsonb_build_object(
      'id', 'lesson-introduction', 'title', test.title,
      'blocks', jsonb_build_array(jsonb_build_object(
        'type', 'paragraph', 'content', test.description
      ))
    ))
  ))),
  coalesce(test.draft_content -> 'questions', '[]'::jsonb),
  jsonb_build_object(
    'title', test.title,
    'description', test.description,
    'ogTitle', test.title,
    'ogDescription', test.description,
    'ogImage', '',
    'indexable', true
  ),
  test.jurisdiction, test.effective_date, test.reviewer, test.reviewed_at,
  test.next_review_at, test.sources, test.content_hash,
  test.reviewed_content_hash, test.updated_by, test.created_at, test.updated_at
from public.tests test
on conflict (test_id) do nothing;

-- Existing test revisions are immutable. The compatibility snapshot with CMS
-- content is created only after the v1 hash contract has been calculated below.

insert into public.article_drafts (
  article_id, slug, title, description, cover_image, blocks, seo,
  jurisdiction, effective_date, reviewer, reviewed_at, next_review_at, sources,
  content_hash, reviewed_content_hash, updated_by, created_at, updated_at
)
select
  article.id, article.slug, article.title, article.description, article.cover_image,
  article.blocks,
  jsonb_build_object(
    'title', article.title,
    'description', article.description,
    'ogTitle', article.title,
    'ogDescription', article.description,
    'ogImage', article.cover_image,
    'indexable', true
  ),
  article.jurisdiction, article.effective_date, article.reviewer,
  article.reviewed_at, article.next_review_at, article.sources,
  article.content_hash, article.reviewed_content_hash, article.updated_by,
  article.created_at, article.updated_at
from public.articles article
on conflict (article_id) do nothing;

insert into public.article_revisions (
  article_id, version, slug, title, description, cover_image, blocks, seo,
  jurisdiction, effective_date, reviewer, reviewed_at, next_review_at, sources,
  content_hash, published_at, published_by
)
select
  article.id, 1, article.slug, article.title, article.description,
  article.cover_image, article.blocks, draft.seo, article.jurisdiction,
  article.effective_date, article.reviewer, article.reviewed_at,
  article.next_review_at, article.sources, article.content_hash,
  coalesce(article.published_at, article.created_at), article.updated_by
from public.articles article
join public.article_drafts draft on draft.article_id = article.id
where article.is_published
  and not exists (
    select 1 from public.article_revisions revision where revision.article_id = article.id
  );

update public.articles article
set current_revision_id = revision.id,
    content_version = revision.version,
    seo = revision.seo
from public.article_revisions revision
where revision.article_id = article.id
  and revision.version = 1
  and article.current_revision_id is null;

create or replace function private.course_content_hash(
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'slug', p_slug,
    'title', p_title,
    'description', p_description,
    'icon', p_icon,
    'durationMinutes', p_duration_minutes,
    'content', p_content,
    'questions', p_questions,
    'seo', p_seo
  )::text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function private.article_draft_content_hash(
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_seo jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'slug', p_slug,
    'title', p_title,
    'description', p_description,
    'coverImage', p_cover_image,
    'blocks', p_blocks,
    'seo', p_seo
  )::text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function private.sync_content_asset_usages(
  p_owner_type text,
  p_owner_id uuid,
  p_owner_version integer,
  p_document jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected integer;
  v_inserted integer;
begin
  if p_owner_type not in (
    'course_draft', 'course_revision', 'article_draft', 'article_revision'
  ) then
    raise exception using errcode = 'invalid_parameter_value', message = 'CONTENT_ASSET_OWNER_INVALID';
  end if;
  select count(distinct (matches.captures)[1]) into v_expected
  from regexp_matches(
    coalesce(p_document, '{}'::jsonb)::text,
    '/api/content-assets/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})',
    'g'
  ) as matches(captures);
  delete from public.content_asset_usages usage
  where usage.owner_type = p_owner_type
    and usage.owner_id = p_owner_id
    and usage.owner_version = p_owner_version;
  insert into public.content_asset_usages(
    asset_id, owner_type, owner_id, owner_version, usage_key
  )
  select distinct
    asset.id, p_owner_type, p_owner_id, p_owner_version,
    '/api/content-assets/' || asset.id::text
  from regexp_matches(
    coalesce(p_document, '{}'::jsonb)::text,
    '/api/content-assets/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})',
    'g'
  ) as matches(captures)
  join public.content_assets asset
    on asset.id = (matches.captures)[1]::uuid and asset.status = 'active';
  get diagnostics v_inserted = row_count;
  if v_inserted <> v_expected then
    raise exception using errcode = 'foreign_key_violation', message = 'CONTENT_ASSET_REFERENCE_INVALID';
  end if;
  update public.content_assets asset
  set last_referenced_at = statement_timestamp()
  where exists (
    select 1 from public.content_asset_usages usage
    where usage.asset_id = asset.id
      and usage.owner_type = p_owner_type
      and usage.owner_id = p_owner_id
      and usage.owner_version = p_owner_version
  );
end;
$$;

-- Recalculate the one-time compatibility backfill with the v1 hash contract.
update public.course_drafts draft
set content_hash = private.course_content_hash(
      draft.slug, draft.title, draft.description, draft.icon,
      draft.duration_minutes, draft.content, draft.questions, draft.seo
    ),
    reviewed_content_hash = case
      when draft.reviewed_content_hash is null then null
      else private.course_content_hash(
        draft.slug, draft.title, draft.description, draft.icon,
        draft.duration_minutes, draft.content, draft.questions, draft.seo
      )
    end;

update public.tests test
set content_hash = draft.content_hash,
    reviewed_content_hash = case
      when test.reviewed_content_hash is null then null else draft.content_hash
    end,
    icon = draft.icon,
    seo = draft.seo
from public.course_drafts draft
where draft.test_id = test.id;

with source_revision as (
  select
    test.id as test_id,
    test.content_version + 1 as next_version,
    draft.slug,
    draft.title,
    draft.description,
    draft.icon,
    draft.content,
    draft.seo,
    draft.content_hash,
    draft.jurisdiction,
    draft.effective_date,
    draft.reviewer,
    draft.reviewed_at,
    draft.next_review_at,
    draft.sources,
    revision.questions,
    revision.question_count,
    draft.duration_minutes,
    least(draft.pass_score, revision.question_count) as pass_score,
    revision.published_at,
    revision.published_by,
    answer_key.correct_positions,
    answer_key.explanations
  from public.tests test
  join public.course_drafts draft on draft.test_id = test.id
  join public.test_revisions revision on revision.id = test.current_revision_id
  join private.test_revision_answer_keys answer_key
    on answer_key.revision_id = revision.id
),
inserted_revision as (
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, icon, content, seo,
    content_hash, jurisdiction, effective_date, reviewer, reviewed_at,
    next_review_at, sources, questions, question_count, duration_minutes,
    pass_score, published_at, published_by
  )
  select
    gen_random_uuid(), source.test_id, source.next_version, source.slug,
    source.title, source.description, source.icon, source.content, source.seo,
    source.content_hash, source.jurisdiction, source.effective_date,
    source.reviewer, source.reviewed_at, source.next_review_at, source.sources,
    source.questions, source.question_count, source.duration_minutes,
    source.pass_score, source.published_at, source.published_by
  from source_revision source
  returning id, test_id, version
),
copied_answer_key as (
  insert into private.test_revision_answer_keys (
    revision_id, correct_positions, explanations
  )
  select inserted.id, source.correct_positions, source.explanations
  from inserted_revision inserted
  join source_revision source on source.test_id = inserted.test_id
  returning revision_id
)
update public.tests test
set current_revision_id = inserted.id,
    content_version = inserted.version
from inserted_revision inserted
where test.id = inserted.test_id
  and exists (
    select 1 from copied_answer_key copied where copied.revision_id = inserted.id
  );

do $migration$
begin
  if exists (
    select 1
    from public.tests test
    join public.test_revisions revision on revision.id = test.current_revision_id
    where test.current_revision_id is not null
      and revision.content_hash is distinct from test.content_hash
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_REVISION_BACKFILL_INCOMPLETE';
  end if;
end;
$migration$;

update public.article_drafts draft
set content_hash = private.article_draft_content_hash(
      draft.slug, draft.title, draft.description, draft.cover_image,
      draft.blocks, draft.seo
    ),
    reviewed_content_hash = case
      when draft.reviewed_content_hash is null then null
      else private.article_draft_content_hash(
        draft.slug, draft.title, draft.description, draft.cover_image,
        draft.blocks, draft.seo
      )
    end;

update public.articles article
set content_hash = draft.content_hash,
    reviewed_content_hash = case
      when article.reviewed_content_hash is null then null else draft.content_hash
    end,
    seo = draft.seo
from public.article_drafts draft
where draft.article_id = article.id;

update public.article_revisions revision
set content_hash = draft.content_hash,
    seo = draft.seo
from public.article_drafts draft
join public.articles article on article.id = draft.article_id
where revision.id = article.current_revision_id;

create trigger article_revisions_immutable
before update or delete on public.article_revisions
for each row execute function private.reject_immutable_row_change();

create or replace function public.save_course_draft(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_test_id uuid;
  v_slug text := lower(btrim(p_slug));
  v_hash text;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 80
    or char_length(btrim(p_title)) not between 3 and 200
    or char_length(coalesce(p_description, '')) > 1000
    or char_length(coalesce(p_icon, '')) not between 1 and 40
    or p_duration_minutes not between 1 and 120
    or jsonb_typeof(p_content) <> 'object'
    or jsonb_typeof(p_content -> 'modules') <> 'array'
    or jsonb_array_length(p_content -> 'modules') not between 1 and 50
    or pg_column_size(p_content) > 524288
    or jsonb_typeof(p_questions) <> 'array'
    or jsonb_array_length(p_questions) <> 5
    or pg_column_size(p_questions) > 262144
    or jsonb_typeof(p_seo) <> 'object'
    or pg_column_size(p_seo) > 32768 then
    raise exception using errcode = 'check_violation', message = 'COURSE_DRAFT_INVALID';
  end if;

  v_hash := private.course_content_hash(
    v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
    coalesce(nullif(btrim(p_icon), ''), 'factory'), p_duration_minutes,
    p_content, p_questions, p_seo
  );

  if p_test_id is null then
    insert into public.tests (
      slug, title, description, icon, seo, draft_content, duration_minutes,
      pass_score, status, jurisdiction, effective_date, reviewer, reviewed_at,
      next_review_at, sources, content_hash, reviewed_content_hash,
      created_by, updated_by
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_seo,
      jsonb_build_object('questions', p_questions), p_duration_minutes, 4,
      'draft', nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
      nullif(p_review_metadata ->> 'effectiveDate', '')::date,
      nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
      nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
      nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
      coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
      v_hash, null, v_actor_id, v_actor_id
    ) returning * into v_test;
    v_test_id := v_test.id;
    insert into public.course_drafts (
      test_id, slug, title, description, icon, duration_minutes, pass_score,
      content, questions, seo, jurisdiction, effective_date, reviewer,
      reviewed_at, next_review_at, sources, content_hash,
      reviewed_content_hash, updated_by
    ) values (
      v_test.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_duration_minutes, 4,
      p_content, p_questions, p_seo,
      nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
      nullif(p_review_metadata ->> 'effectiveDate', '')::date,
      nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
      nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
      nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
      coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
      v_hash, null, v_actor_id
    ) returning * into v_draft;
  else
    select * into v_test from public.tests where id = p_test_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
    end if;
    select * into v_draft from public.course_drafts where test_id = p_test_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
    end if;
    if p_expected_version is null or v_draft.draft_version <> p_expected_version then
      raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
    end if;
    if v_test.current_revision_id is not null
      and v_slug <> v_test.slug
      and v_slug <> v_draft.slug then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'PUBLISHED_COURSE_SLUG_LOCKED';
    end if;
    update public.course_drafts
    set slug = v_slug,
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        icon = coalesce(nullif(btrim(p_icon), ''), 'factory'),
        duration_minutes = p_duration_minutes,
        pass_score = 4,
        content = p_content,
        questions = p_questions,
        seo = p_seo,
        jurisdiction = nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_review_metadata ->> 'effectiveDate', '')::date,
        reviewer = nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
        reviewed_at = nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
        next_review_at = nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
        sources = coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
        content_hash = v_hash,
        reviewed_content_hash = case
          when content_hash = v_hash then reviewed_content_hash else null
        end,
        draft_version = draft_version + 1,
        updated_by = v_actor_id,
        updated_at = statement_timestamp()
    where test_id = p_test_id
    returning * into v_draft;
    v_test_id := p_test_id;
    if v_test.current_revision_id is null then
      update public.tests
      set slug = v_draft.slug,
          title = v_draft.title,
          description = v_draft.description,
          icon = v_draft.icon,
          seo = v_draft.seo,
          draft_content = jsonb_build_object('questions', v_draft.questions),
          duration_minutes = v_draft.duration_minutes,
          pass_score = v_draft.pass_score,
          content_hash = v_draft.content_hash,
          updated_by = v_actor_id
      where id = p_test_id;
    end if;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'test', v_test_id::text, 'course.draft_saved',
    jsonb_build_object(
      'slug', v_draft.slug,
      'contentHash', v_draft.content_hash,
      'draftVersion', v_draft.draft_version
    )
  );

  perform private.sync_content_asset_usages(
    'course_draft', v_test_id, 0,
    jsonb_build_object('content', v_draft.content, 'seo', v_draft.seo)
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'id', v_test_id,
    'slug', v_draft.slug,
    'status', v_test.status,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function public.review_course_draft(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_draft public.course_drafts%rowtype;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_draft from public.course_drafts where test_id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
  end if;
  if v_draft.content_hash is distinct from p_expected_content_hash then
    raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
  end if;
  if v_draft.reviewed_at is null
    or v_draft.reviewed_at > statement_timestamp()
    or v_draft.next_review_at <= statement_timestamp()
    or v_draft.effective_date > current_date
    or nullif(v_draft.jurisdiction, '') is null
    or nullif(v_draft.reviewer, '') is null
    or jsonb_typeof(v_draft.sources) <> 'array'
    or jsonb_array_length(v_draft.sources) < 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'COURSE_REVIEW_REQUIRED';
  end if;
  update public.course_drafts
  set reviewed_content_hash = content_hash,
      updated_by = v_actor_id,
      updated_at = statement_timestamp()
  where test_id = p_test_id
  returning * into v_draft;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'test', p_test_id::text, 'course.draft_reviewed',
    jsonb_build_object('contentHash', v_draft.content_hash)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_test_id, 'contentHash', v_draft.content_hash, 'reviewed', true
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function public.change_course_slug(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_new_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_slug text := lower(btrim(p_new_slug));
  v_hash text;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or char_length(v_slug) > 80 then
    raise exception using errcode = 'check_violation', message = 'COURSE_SLUG_INVALID';
  end if;
  select * into v_test from public.tests where id = p_test_id for update;
  select * into v_draft from public.course_drafts where test_id = p_test_id for update;
  if v_test.id is null or v_draft.test_id is null then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  if v_test.current_revision_id is null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'COURSE_SLUG_ACTION_NOT_REQUIRED';
  end if;
  if p_expected_version is null or v_draft.draft_version <> p_expected_version then
    raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
  end if;
  if v_slug = v_draft.slug then
    return private.ensure_rpc_payload(jsonb_build_object(
      'id', p_test_id,
      'slug', v_draft.slug,
      'draftVersion', v_draft.draft_version,
      'contentHash', v_draft.content_hash
    ));
  end if;
  if exists (
    select 1 from public.tests other
    where other.id <> p_test_id and other.slug = v_slug
  ) or exists (
    select 1 from public.course_drafts other
    where other.test_id <> p_test_id and other.slug = v_slug
  ) or exists (
    select 1 from public.course_slug_redirects redirect
    where redirect.old_slug = v_slug and redirect.test_id <> p_test_id
  ) then
    raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
  end if;
  v_hash := private.course_content_hash(
    v_slug, v_draft.title, v_draft.description, v_draft.icon,
    v_draft.duration_minutes, v_draft.content, v_draft.questions, v_draft.seo
  );
  update public.course_drafts
  set slug = v_slug,
      content_hash = v_hash,
      reviewed_content_hash = null,
      draft_version = draft_version + 1,
      updated_by = v_actor_id,
      updated_at = statement_timestamp()
  where test_id = p_test_id
  returning * into v_draft;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, before_data, after_data
  ) values (
    v_actor_id, 'test', p_test_id::text, 'course.slug_changed',
    jsonb_build_object('slug', v_test.slug),
    jsonb_build_object('slug', v_draft.slug, 'contentHash', v_draft.content_hash)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_test_id,
    'slug', v_draft.slug,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function private.publish_course_revision_unmetered(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_revision_id uuid := gen_random_uuid();
  v_version integer;
  v_public_questions jsonb := '[]'::jsonb;
  v_public_options jsonb;
  v_question jsonb;
  v_option jsonb;
  v_question_id uuid;
  v_option_id uuid;
  v_question_position integer := 0;
  v_option_position integer;
  v_correct integer;
  v_correct_positions smallint[] := '{}'::smallint[];
  v_explanations text[] := '{}'::text[];
begin
  select * into v_test from public.tests where id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_draft from public.course_drafts where test_id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
  end if;
  if p_expected_content_hash is not null
    and v_draft.content_hash is distinct from p_expected_content_hash then
    raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
  end if;
  if v_draft.reviewed_content_hash is distinct from v_draft.content_hash
    or v_draft.reviewed_at is null
    or v_draft.reviewed_at > statement_timestamp()
    or v_draft.next_review_at <= statement_timestamp()
    or v_draft.effective_date > current_date
    or nullif(v_draft.jurisdiction, '') is null
    or nullif(v_draft.reviewer, '') is null
    or jsonb_typeof(v_draft.sources) <> 'array'
    or jsonb_array_length(v_draft.sources) < 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'COURSE_REVIEW_REQUIRED';
  end if;
  if jsonb_typeof(v_draft.questions) <> 'array'
    or jsonb_array_length(v_draft.questions) <> 5 then
    raise exception using errcode = 'check_violation', message = 'TEST_QUESTIONS_INVALID';
  end if;

  for v_question in select value from jsonb_array_elements(v_draft.questions)
  loop
    v_question_position := v_question_position + 1;
    v_question_id := gen_random_uuid();
    v_public_options := '[]'::jsonb;
    v_option_position := 0;
    v_correct := coalesce((v_question ->> 'correctOptionIndex')::integer, -1);
    if char_length(btrim(v_question ->> 'text')) < 3
      or jsonb_typeof(v_question -> 'options') <> 'array'
      or jsonb_array_length(v_question -> 'options') not between 2 and 6
      or v_correct < 0
      or v_correct >= jsonb_array_length(v_question -> 'options') then
      raise exception using errcode = 'check_violation', message = 'TEST_QUESTION_INVALID';
    end if;
    for v_option in select value from jsonb_array_elements(v_question -> 'options')
    loop
      if char_length(btrim(v_option #>> '{}')) < 1 then
        raise exception using errcode = 'check_violation', message = 'TEST_OPTION_INVALID';
      end if;
      v_option_id := gen_random_uuid();
      v_public_options := v_public_options || jsonb_build_array(jsonb_build_object(
        'id', v_option_id,
        'text', btrim(v_option #>> '{}'),
        'position', v_option_position + 1
      ));
      v_option_position := v_option_position + 1;
    end loop;
    v_public_questions := v_public_questions || jsonb_build_array(jsonb_build_object(
      'id', v_question_id,
      'text', btrim(v_question ->> 'text'),
      'position', v_question_position,
      'options', v_public_options
    ));
    v_correct_positions := array_append(v_correct_positions, v_correct::smallint);
    v_explanations := array_append(
      v_explanations,
      private.normalize_profile_text(v_question ->> 'explanation')
    );
  end loop;

  v_version := v_test.content_version + 1;
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, icon, content, seo,
    content_hash, jurisdiction, effective_date, reviewer, reviewed_at,
    next_review_at, sources, questions, question_count, duration_minutes,
    pass_score, published_by
  ) values (
    v_revision_id, v_test.id, v_version, v_draft.slug, v_draft.title,
    v_draft.description, v_draft.icon, v_draft.content, v_draft.seo,
    v_draft.content_hash, v_draft.jurisdiction, v_draft.effective_date,
    v_draft.reviewer, v_draft.reviewed_at, v_draft.next_review_at,
    v_draft.sources, v_public_questions, v_question_position,
    v_draft.duration_minutes, least(v_draft.pass_score, v_question_position),
    p_actor_id
  );
  insert into private.test_revision_answer_keys (
    revision_id, correct_positions, explanations
  ) values (v_revision_id, v_correct_positions, v_explanations);

  perform private.sync_content_asset_usages(
    'course_revision', v_test.id, v_version,
    jsonb_build_object('content', v_draft.content, 'seo', v_draft.seo)
  );

  if v_test.current_revision_id is not null and v_test.slug <> v_draft.slug then
    insert into public.course_slug_redirects(old_slug, test_id)
    values (v_test.slug, v_test.id)
    on conflict (old_slug) do update set test_id = excluded.test_id;
  end if;

  update public.tests
  set slug = v_draft.slug,
      title = v_draft.title,
      description = v_draft.description,
      icon = v_draft.icon,
      seo = v_draft.seo,
      draft_content = jsonb_build_object('questions', v_draft.questions),
      current_revision_id = v_revision_id,
      content_version = v_version,
      duration_minutes = v_draft.duration_minutes,
      pass_score = least(v_draft.pass_score, v_question_position),
      status = 'published',
      jurisdiction = v_draft.jurisdiction,
      effective_date = v_draft.effective_date,
      reviewer = v_draft.reviewer,
      reviewed_at = v_draft.reviewed_at,
      next_review_at = v_draft.next_review_at,
      sources = v_draft.sources,
      content_hash = v_draft.content_hash,
      reviewed_content_hash = v_draft.content_hash,
      updated_by = p_actor_id
  where id = v_test.id;

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    p_actor_id, 'test', v_test.id::text, 'course.published',
    jsonb_build_object(
      'slug', v_draft.slug,
      'version', v_version,
      'contentHash', v_draft.content_hash
    )
  );
  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_draft.slug,
    'status', 'published',
    'version', v_version,
    'revisionId', v_revision_id,
    'contentHash', v_draft.content_hash
  );
end;
$$;

create or replace function public.publish_course_revision(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  begin
    v_result := private.publish_course_revision_unmetered(
      v_actor_id, p_test_id, p_expected_content_hash
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.get_test_editor_payload(p_actor_id uuid, p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_test from public.tests where id = p_test_id;
  select * into v_draft from public.course_drafts where test_id = p_test_id;
  if v_test.id is null or v_draft.test_id is null then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_draft.slug,
    'title', v_draft.title,
    'description', v_draft.description,
    'icon', v_draft.icon,
    'durationMinutes', v_draft.duration_minutes,
    'jurisdiction', coalesce(v_draft.jurisdiction, ''),
    'effectiveDate', coalesce(v_draft.effective_date::text, ''),
    'reviewer', coalesce(v_draft.reviewer, ''),
    'reviewedAt', coalesce(v_draft.reviewed_at::text, ''),
    'nextReviewAt', coalesce(v_draft.next_review_at::text, ''),
    'sources', v_draft.sources,
    'status', v_test.status,
    'publicationState', case
      when v_test.current_revision_id is null then 'never_published'
      when v_test.status = 'archived' then 'archived'
      when v_test.status = 'draft' then 'draft'
      when v_test.content_hash = v_draft.content_hash then 'published'
      else 'published_with_draft_changes'
    end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'reviewedContentHash', v_draft.reviewed_content_hash,
    'content', v_draft.content,
    'seo', v_draft.seo,
    'questions', v_draft.questions
  );
end;
$$;

create or replace function public.set_test_status(
  p_actor_id uuid,
  p_test_id uuid,
  p_status public.test_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  begin
    if p_status = 'published' then
      select * into v_draft from public.course_drafts where test_id = p_test_id;
      v_result := private.publish_course_revision_unmetered(
        v_actor_id, p_test_id, v_draft.content_hash
      );
    else
      update public.tests
      set status = p_status, updated_by = v_actor_id
      where id = p_test_id
      returning * into v_test;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
      end if;
      insert into public.admin_audit_log (
        actor_user_id, action, target_type, target_id, after_data
      ) values (
        v_actor_id, 'test.status_changed', 'test', p_test_id::text,
        jsonb_build_object('status', p_status)
      );
      v_result := jsonb_build_object(
        'id', v_test.id, 'slug', v_test.slug, 'status', v_test.status
      );
    end if;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.resolve_course_slug(p_old_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select revision.slug
  from public.course_slug_redirects redirect
  join public.tests test on test.id = redirect.test_id
  join public.test_revisions revision on revision.id = test.current_revision_id
  where redirect.old_slug = p_old_slug
    and test.status = 'published';
$$;

create or replace function public.delete_unused_course_draft(
  p_actor_id uuid,
  p_test_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_asset_ids uuid[] := '{}'::uuid[];
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_test from public.tests where id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  if v_test.current_revision_id is not null
    or exists (select 1 from public.test_revisions where test_id = p_test_id)
    or exists (select 1 from public.course_slug_redirects where test_id = p_test_id) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'COURSE_ARCHIVE_REQUIRED';
  end if;

  select coalesce(array_agg(distinct usage.asset_id), '{}'::uuid[])
  into v_asset_ids
  from public.content_asset_usages usage
  where usage.owner_type = 'course_draft'
    and usage.owner_id = p_test_id;

  delete from public.content_asset_usages
  where owner_type = 'course_draft'
    and owner_id = p_test_id;
  delete from public.tests where id = p_test_id;

  update public.content_assets asset
  set status = 'orphan_candidate'
  where asset.id = any(v_asset_ids)
    and not exists (
      select 1 from public.content_asset_usages usage where usage.asset_id = asset.id
    );

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, before_data
  ) values (
    v_actor_id, 'test', p_test_id::text, 'course.unused_draft_deleted',
    jsonb_build_object('slug', v_test.slug)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_test_id, 'deleted', true
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function public.mark_content_asset_orphan(
  p_actor_id uuid,
  p_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_asset public.content_assets%rowtype;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_asset from public.content_assets where id = p_asset_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'CONTENT_ASSET_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.content_asset_usages usage where usage.asset_id = p_asset_id
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CONTENT_ASSET_IN_USE';
  end if;
  if v_asset.status <> 'delete_pending' then
    update public.content_assets
    set status = 'orphan_candidate'
    where id = p_asset_id;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'content_asset', p_asset_id::text, 'content_asset.orphan_marked',
    jsonb_build_object('sha256', v_asset.sha256)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_asset_id,
    'status', case when v_asset.status = 'delete_pending' then 'delete_pending' else 'orphan_candidate' end
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function public.delete_verified_orphan_asset(
  p_actor_id uuid,
  p_asset_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_asset public.content_assets%rowtype;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_asset from public.content_assets where id = p_asset_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'CONTENT_ASSET_NOT_FOUND';
  end if;
  if v_asset.status not in ('orphan_candidate', 'delete_pending')
    or exists (
      select 1 from public.content_asset_usages usage where usage.asset_id = p_asset_id
    ) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CONTENT_ASSET_DELETE_BLOCKED';
  end if;
  update public.content_assets
  set status = 'delete_pending'
  where id = p_asset_id;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'content_asset', p_asset_id::text, 'content_asset.delete_prepared',
    jsonb_build_object('sha256', v_asset.sha256)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_asset_id,
    'storageKey', v_asset.storage_key,
    'sha256', v_asset.sha256,
    'status', 'delete_pending'
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function private.save_article_draft_unmetered(
  p_article_id uuid,
  p_original_slug text,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_article public.articles%rowtype;
  v_draft public.article_drafts%rowtype;
  v_slug text := lower(btrim(p_slug));
  v_seo jsonb := coalesce(p_review_metadata -> 'seo', '{}'::jsonb);
  v_expected_version bigint := nullif(p_review_metadata ->> 'draftVersion', '')::bigint;
  v_hash text;
begin
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 120
    or char_length(btrim(p_title)) not between 3 and 200
    or jsonb_typeof(p_blocks) <> 'array'
    or jsonb_array_length(p_blocks) > 100
    or pg_column_size(p_blocks) > 131072
    or jsonb_typeof(v_seo) <> 'object'
    or pg_column_size(v_seo) > 32768 then
    raise exception using errcode = 'check_violation', message = 'ARTICLE_DRAFT_INVALID';
  end if;
  if v_seo = '{}'::jsonb then
    v_seo := jsonb_build_object(
      'title', btrim(p_title),
      'description', coalesce(btrim(p_description), ''),
      'ogTitle', btrim(p_title),
      'ogDescription', coalesce(btrim(p_description), ''),
      'ogImage', coalesce(btrim(p_cover_image), ''),
      'indexable', true
    );
  end if;
  v_hash := private.article_draft_content_hash(
    v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
    coalesce(btrim(p_cover_image), ''), p_blocks, v_seo
  );
  if p_article_id is null then
    insert into public.articles (
      slug, title, description, cover_image, blocks, seo, status,
      is_published, content_hash, reviewed_content_hash, created_by, updated_by
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), '[]'::jsonb, v_seo, 'draft',
      false, v_hash, null, v_actor_id, v_actor_id
    ) returning * into v_article;
    insert into public.article_drafts (
      article_id, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, reviewer, reviewed_at, next_review_at,
      sources, content_hash, reviewed_content_hash, updated_by
    ) values (
      v_article.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), p_blocks, v_seo,
      nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
      nullif(p_review_metadata ->> 'effectiveDate', '')::date,
      nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
      nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
      nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
      coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
      v_hash, null, v_actor_id
    ) returning * into v_draft;
  else
    select * into v_article from public.articles where id = p_article_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'ARTICLE_NOT_FOUND';
    end if;
    select * into v_draft from public.article_drafts where article_id = p_article_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'ARTICLE_DRAFT_NOT_FOUND';
    end if;
    if v_expected_version is null or v_draft.draft_version <> v_expected_version then
      raise exception using errcode = 'serialization_failure', message = 'ARTICLE_DRAFT_CONFLICT';
    end if;
    update public.article_drafts
    set slug = v_slug,
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        cover_image = coalesce(btrim(p_cover_image), ''),
        blocks = p_blocks,
        seo = v_seo,
        jurisdiction = nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_review_metadata ->> 'effectiveDate', '')::date,
        reviewer = nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
        reviewed_at = nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
        next_review_at = nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
        sources = coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
        content_hash = v_hash,
        reviewed_content_hash = case
          when content_hash = v_hash then reviewed_content_hash else null
        end,
        draft_version = draft_version + 1,
        updated_by = v_actor_id,
        updated_at = statement_timestamp()
    where article_id = p_article_id
    returning * into v_draft;
    if v_article.current_revision_id is null then
      update public.articles
      set slug = v_draft.slug,
          title = v_draft.title,
          description = v_draft.description,
          cover_image = v_draft.cover_image,
          seo = v_draft.seo,
          content_hash = v_draft.content_hash,
          updated_by = v_actor_id
      where id = p_article_id;
    end if;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', v_article.id::text, 'article.draft_saved',
    jsonb_build_object(
      'slug', v_draft.slug,
      'contentHash', v_draft.content_hash,
      'draftVersion', v_draft.draft_version
    )
  );
  perform private.sync_content_asset_usages(
    'article_draft', v_article.id, 0,
    jsonb_build_object('blocks', v_draft.blocks, 'seo', v_draft.seo)
  );
  return jsonb_build_object(
    'id', v_article.id,
    'slug', v_draft.slug,
    'status', v_article.status,
    'publishedAt', v_article.published_at,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'reviewedContentHash', v_draft.reviewed_content_hash
  );
end;
$$;

create or replace function public.review_article_draft(
  p_article_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_draft public.article_drafts%rowtype;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  select * into v_draft
  from public.article_drafts
  where article_id = p_article_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ARTICLE_DRAFT_NOT_FOUND';
  end if;
  if v_draft.content_hash is distinct from p_expected_content_hash then
    raise exception using errcode = 'serialization_failure', message = 'ARTICLE_DRAFT_CONFLICT';
  end if;
  if v_draft.reviewed_at is null
    or v_draft.reviewed_at > statement_timestamp()
    or v_draft.next_review_at <= statement_timestamp()
    or v_draft.effective_date > current_date
    or nullif(v_draft.jurisdiction, '') is null
    or nullif(v_draft.reviewer, '') is null
    or jsonb_typeof(v_draft.sources) <> 'array'
    or jsonb_array_length(v_draft.sources) < 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ARTICLE_REVIEW_REQUIRED';
  end if;
  update public.article_drafts
  set reviewed_content_hash = content_hash,
      updated_by = v_actor_id,
      updated_at = statement_timestamp()
  where article_id = p_article_id
  returning * into v_draft;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', p_article_id::text, 'article.draft_reviewed',
    jsonb_build_object('contentHash', v_draft.content_hash)
  );
  return private.ensure_rpc_payload(jsonb_build_object(
    'id', p_article_id,
    'contentHash', v_draft.content_hash,
    'reviewed', true
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function private.set_article_status_unmetered(
  p_article_id uuid,
  p_status public.article_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_article public.articles%rowtype;
  v_draft public.article_drafts%rowtype;
  v_revision_id uuid;
  v_version integer;
  v_previous_slug text;
begin
  select * into v_article from public.articles where id = p_article_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ARTICLE_NOT_FOUND';
  end if;
  v_previous_slug := v_article.slug;
  select * into v_draft from public.article_drafts where article_id = p_article_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ARTICLE_DRAFT_NOT_FOUND';
  end if;
  if p_status = 'published' then
    if v_draft.reviewed_content_hash is distinct from v_draft.content_hash
      or v_draft.reviewed_at is null
      or v_draft.reviewed_at > statement_timestamp()
      or v_draft.next_review_at <= statement_timestamp()
      or v_draft.effective_date > current_date
      or nullif(v_draft.jurisdiction, '') is null
      or nullif(v_draft.reviewer, '') is null
      or jsonb_typeof(v_draft.sources) <> 'array'
      or jsonb_array_length(v_draft.sources) < 1 then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ARTICLE_REVIEW_REQUIRED';
    end if;
    v_version := v_article.content_version + 1;
    insert into public.article_revisions (
      article_id, version, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, reviewer, reviewed_at, next_review_at,
      sources, content_hash, published_by
    ) values (
      v_article.id, v_version, v_draft.slug, v_draft.title,
      v_draft.description, v_draft.cover_image, v_draft.blocks, v_draft.seo,
      v_draft.jurisdiction, v_draft.effective_date, v_draft.reviewer,
      v_draft.reviewed_at, v_draft.next_review_at, v_draft.sources,
      v_draft.content_hash, v_actor_id
    ) returning id into v_revision_id;
    perform private.sync_content_asset_usages(
      'article_revision', v_article.id, v_version,
      jsonb_build_object('blocks', v_draft.blocks, 'seo', v_draft.seo)
    );
    if v_article.current_revision_id is not null and v_article.slug <> v_draft.slug then
      insert into public.article_slug_redirects(old_slug, article_id)
      values (v_article.slug, v_article.id)
      on conflict (old_slug) do update set article_id = excluded.article_id;
    end if;
    update public.article_drafts
    set reviewed_content_hash = content_hash,
        updated_by = v_actor_id,
        updated_at = statement_timestamp()
    where article_id = p_article_id
    returning * into v_draft;
    update public.articles
    set slug = v_draft.slug,
        title = v_draft.title,
        description = v_draft.description,
        cover_image = v_draft.cover_image,
        blocks = v_draft.blocks,
        seo = v_draft.seo,
        status = 'published',
        is_published = true,
        published_at = coalesce(published_at, statement_timestamp()),
        current_revision_id = v_revision_id,
        content_version = v_version,
        jurisdiction = v_draft.jurisdiction,
        effective_date = v_draft.effective_date,
        reviewer = v_draft.reviewer,
        reviewed_at = v_draft.reviewed_at,
        next_review_at = v_draft.next_review_at,
        sources = v_draft.sources,
        content_hash = v_draft.content_hash,
        reviewed_content_hash = v_draft.content_hash,
        updated_by = v_actor_id
    where id = p_article_id
    returning * into v_article;
  else
    update public.articles
    set status = p_status,
        is_published = false,
        updated_by = v_actor_id
    where id = p_article_id
    returning * into v_article;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', v_article.id::text, 'article.status_changed',
    jsonb_build_object(
      'status', v_article.status,
      'version', v_article.content_version,
      'contentHash', v_draft.content_hash
    )
  );
  return jsonb_build_object(
    'id', v_article.id,
    'slug', case when p_status = 'published' then v_article.slug else v_draft.slug end,
    'previousSlug', v_previous_slug,
    'status', v_article.status,
    'publishedAt', v_article.published_at,
    'version', v_article.content_version,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'reviewedContentHash', v_draft.reviewed_content_hash
  );
end;
$$;

alter table public.course_drafts enable row level security;
alter table public.course_slug_redirects enable row level security;
alter table public.article_drafts enable row level security;
alter table public.article_revisions enable row level security;
alter table public.content_assets enable row level security;
alter table public.content_asset_usages enable row level security;

revoke all on public.course_drafts, public.course_slug_redirects,
  public.article_drafts, public.article_revisions, public.content_assets,
  public.content_asset_usages from public, anon, authenticated;

grant select, insert, update, delete on public.course_drafts,
  public.course_slug_redirects, public.article_drafts, public.article_revisions,
  public.content_assets, public.content_asset_usages to service_role;
grant select, insert, update, delete on public.organizations,
  public.organization_aliases to service_role;

revoke select on public.tests from anon, authenticated;
grant select (id, current_revision_id, status) on public.tests to anon, authenticated;

grant select (
  id, test_id, version, slug, title, description, icon, content, seo,
  content_hash, jurisdiction, effective_date, reviewer, reviewed_at,
  next_review_at, sources, questions, question_count, duration_minutes,
  pass_score, published_at
) on public.test_revisions to anon, authenticated;

revoke execute on function public.save_test_content(
  uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb
) from authenticated;
revoke all on function public.save_course_draft(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.review_course_draft(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.change_course_slug(uuid,uuid,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_course_revision(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.resolve_course_slug(text)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_unused_course_draft(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.mark_content_asset_orphan(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.delete_verified_orphan_asset(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.review_article_draft(uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_course_draft(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.review_course_draft(uuid,uuid,text) to authenticated;
grant execute on function public.change_course_slug(uuid,uuid,bigint,text) to authenticated;
grant execute on function public.publish_course_revision(uuid,uuid,text) to authenticated;
grant execute on function public.resolve_course_slug(text) to anon, authenticated;
grant execute on function public.delete_unused_course_draft(uuid,uuid) to authenticated;
grant execute on function public.mark_content_asset_orphan(uuid,uuid) to authenticated;
grant execute on function public.delete_verified_orphan_asset(uuid,uuid) to authenticated;
grant execute on function public.review_article_draft(uuid,text) to authenticated;

revoke all on function private.course_content_hash(text,text,text,text,integer,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.article_draft_content_hash(text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.sync_content_asset_usages(text,uuid,integer,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.publish_course_revision_unmetered(uuid,uuid,text)
  from public, anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('content-media', 'content-media', true, 2097152, array['image/webp']::text[])
on conflict (id) do update
set public = true,
    file_size_limit = 2097152,
    allowed_mime_types = array['image/webp']::text[];
