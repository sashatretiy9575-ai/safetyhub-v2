-- Contract half: run only after the v2 application has passed production smoke.

do $contract$
begin
  if exists (select 1 from public.tests where status::text = 'archived') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'UNEXPECTED_ARCHIVED_COURSES';
  end if;
  if exists (select 1 from public.articles where status::text = 'archived') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'UNEXPECTED_ARCHIVED_ARTICLES';
  end if;
end;
$contract$;

drop function if exists public.review_course_draft(uuid,uuid,text);
drop function if exists public.review_article_draft(uuid,text);
drop function if exists public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb);
drop function if exists public.delete_unused_course_draft(uuid,uuid);

drop function if exists public.save_course_draft_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
);
drop function if exists public.save_course_draft(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
);
drop function if exists public.publish_course_revision(uuid,uuid,text);
drop function if exists public.get_test_editor_payload_v2(uuid,uuid);
drop function if exists public.get_test_editor_payload(uuid,uuid);
drop function if exists public.set_test_status(uuid,uuid,public.test_status);
drop function if exists public.change_course_slug(uuid,uuid,bigint,text);

drop function if exists public.save_article_draft_v2(uuid,text,text,text,text,text,jsonb,jsonb);
drop function if exists public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb);
drop function if exists public.set_article_status(uuid,public.article_status);
drop function if exists public.set_article_status_v2(uuid,public.article_status,text);

drop function if exists private.publish_course_revision_unmetered(uuid,uuid,text);
drop function if exists private.save_test_content_unmetered(
  uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb
);
drop function if exists private.set_test_status_unmetered(uuid,uuid,public.test_status);
drop function if exists private.build_test_revision(uuid,uuid);
drop function if exists private.save_article_draft_unmetered(
  uuid,text,text,text,text,text,jsonb,jsonb
);
drop function if exists private.set_article_status_unmetered(uuid,public.article_status);
drop function if exists private.set_article_status_v2_unmetered(uuid,public.article_status,text);

alter table public.tests
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at,
  drop column if exists reviewed_content_hash;

alter table public.test_revisions
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at;

alter table public.course_drafts
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at,
  drop column if exists reviewed_content_hash;

alter table public.articles
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at,
  drop column if exists reviewed_content_hash;

alter table public.article_drafts
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at,
  drop column if exists reviewed_content_hash;

alter table public.article_revisions
  drop column if exists reviewer,
  drop column if exists reviewed_at,
  drop column if exists next_review_at;

-- PostgreSQL enum values cannot be removed in place. Rebuild both enums so
-- archived is absent from the database contract, not merely rejected by UI.
drop policy if exists tests_public_read on public.tests;
drop policy if exists articles_public_read on public.articles;
drop policy if exists revisions_public_read on public.test_revisions;
drop index if exists public.tests_public_idx;

alter table public.tests alter column status drop default;
alter table public.articles alter column status drop default;

create type public.test_status_two_state as enum ('draft', 'published');
create type public.article_status_two_state as enum ('draft', 'published');

alter table public.tests
  alter column status type public.test_status_two_state
  using (status::text::public.test_status_two_state);
alter table public.articles
  alter column status type public.article_status_two_state
  using (status::text::public.article_status_two_state);

drop type public.test_status;
drop type public.article_status;
alter type public.test_status_two_state rename to test_status;
alter type public.article_status_two_state rename to article_status;

alter table public.tests alter column status set default 'draft'::public.test_status;
alter table public.articles alter column status set default 'draft'::public.article_status;

create index tests_public_idx on public.tests (created_at, id)
where status = 'published';

create policy tests_public_read on public.tests
for select to anon, authenticated using (status = 'published');
create policy articles_public_read on public.articles
for select to anon, authenticated using (is_published and status = 'published');
create policy revisions_public_read on public.test_revisions
for select to anon, authenticated using (
  exists (
    select 1
    from public.tests test
    where test.id = test_revisions.test_id
      and test.status = 'published'
      and test.current_revision_id = test_revisions.id
  )
);

alter table public.tests
  drop constraint if exists tests_two_state_status,
  add constraint tests_two_state_status check (status::text in ('draft', 'published'));

alter table public.articles
  drop constraint if exists articles_two_state_status,
  add constraint articles_two_state_status check (status::text in ('draft', 'published'));

create or replace function private.set_article_status_v2_unmetered(
  p_article_id uuid,
  p_status public.article_status,
  p_expected_content_hash text
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
  if p_status not in ('draft', 'published') then
    raise exception using errcode = 'check_violation', message = 'ARTICLE_STATUS_INVALID';
  end if;
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
    if p_expected_content_hash is null
      or v_draft.content_hash is distinct from p_expected_content_hash then
      raise exception using errcode = 'serialization_failure', message = 'ARTICLE_DRAFT_CONFLICT';
    end if;
    v_version := v_article.content_version + 1;
    insert into public.article_revisions (
      article_id, version, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, sources, content_hash, published_by
    ) values (
      v_article.id, v_version, v_draft.slug, v_draft.title,
      v_draft.description, v_draft.cover_image, v_draft.blocks, v_draft.seo,
      v_draft.jurisdiction, v_draft.effective_date, v_draft.sources,
      v_draft.content_hash, v_actor_id
    ) returning id into v_revision_id;
    perform private.sync_content_asset_usages(
      'article_revision', v_article.id, v_version,
      jsonb_build_object('blocks', v_draft.blocks, 'seo', v_draft.seo)
    );
    if v_article.current_revision_id is not null and v_article.slug <> v_draft.slug then
      delete from public.article_slug_redirects
      where old_slug = v_draft.slug and article_id = v_article.id;
      insert into public.article_slug_redirects(old_slug, article_id)
      values (v_article.slug, v_article.id)
      on conflict (old_slug) do update set article_id = excluded.article_id;
    end if;
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
        sources = v_draft.sources,
        content_hash = v_draft.content_hash,
        updated_by = v_actor_id
    where id = p_article_id
    returning * into v_article;
  else
    update public.articles
    set status = 'draft',
        is_published = false,
        updated_by = v_actor_id
    where id = p_article_id
    returning * into v_article;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', v_article.id::text,
    case when p_status = 'published' then 'article.published' else 'article.status_changed' end,
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
    'contentHash', v_draft.content_hash
  );
end;
$$;

create or replace function public.set_article_status_v2(
  p_article_id uuid,
  p_status public.article_status,
  p_expected_content_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.set_article_status_v2_unmetered(
      p_article_id, p_status, p_expected_content_hash
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

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
  p_content_metadata jsonb default '{}'::jsonb
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
  v_sources jsonb := coalesce(p_content_metadata -> 'sources', '[]'::jsonb);
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
    or jsonb_typeof(p_content) is distinct from 'object'
    or jsonb_typeof(p_content -> 'modules') is distinct from 'array'
    or jsonb_array_length(p_content -> 'modules') not between 1 and 50
    or pg_column_size(p_content) > 524288
    or jsonb_typeof(p_questions) is distinct from 'array'
    or jsonb_array_length(p_questions) <> 5
    or pg_column_size(p_questions) > 262144
    or jsonb_typeof(p_seo) is distinct from 'object'
    or pg_column_size(p_seo) > 32768
    or jsonb_typeof(p_content_metadata) is distinct from 'object'
    or char_length(coalesce(p_content_metadata ->> 'jurisdiction', '')) > 120
    or jsonb_typeof(v_sources) is distinct from 'array'
    or jsonb_array_length(v_sources) > 10
    or exists (
      select 1 from jsonb_array_elements(v_sources) source
      where jsonb_typeof(source) is distinct from 'object'
        or char_length(coalesce(source ->> 'title', '')) > 240
        or char_length(coalesce(source ->> 'url', '')) > 2048
        or ((nullif(btrim(source ->> 'title'), '') is null)
          is distinct from (nullif(btrim(source ->> 'url'), '') is null))
        or (nullif(btrim(source ->> 'url'), '') is not null
          and btrim(source ->> 'url') !~ '^https://[^[:space:]]+$')
    ) then
    raise exception using errcode = 'check_violation', message = 'COURSE_DRAFT_INVALID';
  end if;

  select coalesce(jsonb_agg(source), '[]'::jsonb)
  into v_sources
  from jsonb_array_elements(v_sources) source
      where nullif(btrim(source ->> 'title'), '') is not null;

  v_hash := private.course_content_hash_v2(
    v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
    coalesce(nullif(btrim(p_icon), ''), 'factory'), p_duration_minutes,
    p_content, p_questions, p_seo,
    nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
    nullif(p_content_metadata ->> 'effectiveDate', '')::date,
    v_sources
  );

  if p_test_id is null then
    insert into public.tests (
      slug, title, description, icon, seo, draft_content, duration_minutes,
      pass_score, status, jurisdiction, effective_date, sources, content_hash,
      created_by, updated_by
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_seo,
      jsonb_build_object('questions', p_questions), p_duration_minutes, 4,
      'draft', nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
      nullif(p_content_metadata ->> 'effectiveDate', '')::date,
      v_sources, v_hash, v_actor_id, v_actor_id
    ) returning * into v_test;
    v_test_id := v_test.id;
    insert into public.course_drafts (
      test_id, slug, title, description, icon, duration_minutes, pass_score,
      content, questions, seo, jurisdiction, effective_date, sources,
      content_hash, updated_by
    ) values (
      v_test.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_duration_minutes, 4,
      p_content, p_questions, p_seo,
      nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
      nullif(p_content_metadata ->> 'effectiveDate', '')::date,
      v_sources, v_hash, v_actor_id
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
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'PUBLISHED_COURSE_SLUG_LOCKED';
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
        jurisdiction = nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_content_metadata ->> 'effectiveDate', '')::date,
        sources = v_sources,
        content_hash = v_hash,
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
          jurisdiction = v_draft.jurisdiction,
          effective_date = v_draft.effective_date,
          sources = v_draft.sources,
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
    'status', case when v_test.status = 'published' then 'published' else 'draft' end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  ));
exception when others then
  return private.rpc_error_envelope(sqlstate, sqlerrm);
end;
$$;

create or replace function public.save_course_draft_v2(
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
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.save_course_draft_v2_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
      p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
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
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_SLUG_ACTION_NOT_REQUIRED';
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
    select 1 from public.tests other where other.id <> p_test_id and other.slug = v_slug
  ) or exists (
    select 1 from public.course_drafts other
    where other.test_id <> p_test_id and other.slug = v_slug
  ) or exists (
    select 1 from public.course_slug_redirects redirect
    where redirect.old_slug = v_slug and redirect.test_id <> p_test_id
  ) then
    raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
  end if;
  v_hash := private.course_content_hash_v2(
    v_slug, v_draft.title, v_draft.description, v_draft.icon,
    v_draft.duration_minutes, v_draft.content, v_draft.questions, v_draft.seo,
    v_draft.jurisdiction, v_draft.effective_date, v_draft.sources
  );
  update public.course_drafts
  set slug = v_slug,
      content_hash = v_hash,
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
    v_result := private.publish_course_revision_v2_unmetered(
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
    'sources', v_draft.sources,
    'status', case when v_test.status = 'published' then 'published' else 'draft' end,
    'publicationState', case
      when v_test.current_revision_id is null then 'never_published'
      when v_test.status <> 'published' then 'draft'
      when v_test.content_hash = v_draft.content_hash then 'published'
      else 'published_with_draft_changes'
    end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'content', v_draft.content,
    'seo', v_draft.seo,
    'questions', v_draft.questions
  );
end;
$$;

create or replace function public.get_test_editor_payload_v2(p_actor_id uuid, p_test_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_test_editor_payload(p_actor_id, p_test_id);
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
  if p_status not in ('draft', 'published') then
    raise exception using errcode = 'check_violation', message = 'TEST_STATUS_INVALID';
  end if;
  begin
    if p_status = 'published' then
      select * into v_draft from public.course_drafts where test_id = p_test_id;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
      end if;
      v_result := private.publish_course_revision_v2_unmetered(
        v_actor_id, p_test_id, v_draft.content_hash
      );
    else
      update public.tests
      set status = 'draft', updated_by = v_actor_id
      where id = p_test_id
      returning * into v_test;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
      end if;
      insert into public.admin_audit_log (
        actor_user_id, action, target_type, target_id, after_data
      ) values (
        v_actor_id, 'test.status_changed', 'test', p_test_id::text,
        jsonb_build_object('status', 'draft')
      );
      v_result := jsonb_build_object(
        'id', v_test.id, 'slug', v_test.slug, 'status', 'draft'
      );
    end if;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
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
  p_content_metadata jsonb default '{}'::jsonb
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
  v_seo jsonb := coalesce(p_content_metadata -> 'seo', '{}'::jsonb);
  v_expected_version bigint := nullif(p_content_metadata ->> 'draftVersion', '')::bigint;
  v_sources jsonb := coalesce(p_content_metadata -> 'sources', '[]'::jsonb);
  v_hash text;
begin
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 120
    or char_length(btrim(p_title)) not between 3 and 200
    or jsonb_typeof(p_blocks) is distinct from 'array'
    or jsonb_array_length(p_blocks) > 100
    or pg_column_size(p_blocks) > 131072
    or jsonb_typeof(v_seo) is distinct from 'object'
    or pg_column_size(v_seo) > 32768
    or jsonb_typeof(p_content_metadata) is distinct from 'object'
    or char_length(coalesce(p_content_metadata ->> 'jurisdiction', '')) > 120
    or jsonb_typeof(v_sources) is distinct from 'array'
    or jsonb_array_length(v_sources) > 10
    or exists (
      select 1 from jsonb_array_elements(v_sources) source
      where jsonb_typeof(source) is distinct from 'object'
        or char_length(coalesce(source ->> 'title', '')) > 240
        or char_length(coalesce(source ->> 'url', '')) > 2048
        or ((nullif(btrim(source ->> 'title'), '') is null)
          is distinct from (nullif(btrim(source ->> 'url'), '') is null))
        or (nullif(btrim(source ->> 'url'), '') is not null
          and btrim(source ->> 'url') !~ '^https://[^[:space:]]+$')
    ) then
    raise exception using errcode = 'check_violation', message = 'ARTICLE_DRAFT_INVALID';
  end if;
  select coalesce(jsonb_agg(source), '[]'::jsonb)
  into v_sources
  from jsonb_array_elements(v_sources) source
  where nullif(btrim(source ->> 'title'), '') is not null;
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
  v_hash := private.article_content_hash_v2(
    v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
    coalesce(btrim(p_cover_image), ''), p_blocks, v_seo,
    nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
    nullif(p_content_metadata ->> 'effectiveDate', '')::date,
    v_sources
  );
  if p_article_id is null then
    insert into public.articles (
      slug, title, description, cover_image, blocks, seo, status,
      is_published, content_hash, created_by, updated_by,
      jurisdiction, effective_date, sources
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), '[]'::jsonb, v_seo, 'draft',
      false, v_hash, v_actor_id, v_actor_id,
      nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
      nullif(p_content_metadata ->> 'effectiveDate', '')::date,
      v_sources
    ) returning * into v_article;
    insert into public.article_drafts (
      article_id, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, sources, content_hash, updated_by
    ) values (
      v_article.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), p_blocks, v_seo,
      nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
      nullif(p_content_metadata ->> 'effectiveDate', '')::date,
      v_sources, v_hash, v_actor_id
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
        jurisdiction = nullif(btrim(p_content_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_content_metadata ->> 'effectiveDate', '')::date,
        sources = v_sources,
        content_hash = v_hash,
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
          jurisdiction = v_draft.jurisdiction,
          effective_date = v_draft.effective_date,
          sources = v_draft.sources,
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
    'status', case when v_article.status = 'published' then 'published' else 'draft' end,
    'publishedAt', v_article.published_at,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  );
end;
$$;

create or replace function public.save_article_draft(
  p_article_id uuid,
  p_original_slug text,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.save_article_draft_unmetered(
      p_article_id, p_original_slug, p_slug, p_title, p_description,
      p_cover_image, p_blocks, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.save_article_draft_v2(
  p_article_id uuid,
  p_original_slug text,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.save_article_draft_unmetered(
      p_article_id, p_original_slug, p_slug, p_title, p_description,
      p_cover_image, p_blocks, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.set_article_status(
  p_article_id uuid,
  p_status public.article_status,
  p_expected_content_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_result := private.set_article_status_v2_unmetered(
      p_article_id, p_status, p_expected_content_hash
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Keep the canonical non-v2 name on the same atomic implementation for
-- service tooling that still uses the stable endpoint name.
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
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.save_course_draft_v2_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
      p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.save_course_draft(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.save_course_draft_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.publish_course_revision(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.publish_course_revision_v2(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.get_test_editor_payload(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.get_test_editor_payload_v2(uuid,uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.set_test_status(uuid,uuid,public.test_status)
  from public, anon, authenticated, service_role;
revoke all on function public.change_course_slug(uuid,uuid,bigint,text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.save_article_draft_v2(uuid,text,text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.set_article_status(uuid,public.article_status,text)
  from public, anon, authenticated, service_role;
revoke all on function public.set_article_status_v2(uuid,public.article_status,text)
  from public, anon, authenticated, service_role;

grant execute on function public.save_course_draft(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.save_course_draft_v2(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.publish_course_revision(uuid,uuid,text) to authenticated;
grant execute on function public.publish_course_revision_v2(uuid,uuid,text) to authenticated;
grant execute on function public.get_test_editor_payload(uuid,uuid) to authenticated;
grant execute on function public.get_test_editor_payload_v2(uuid,uuid) to authenticated;
grant execute on function public.set_test_status(uuid,uuid,public.test_status) to authenticated;
grant execute on function public.change_course_slug(uuid,uuid,bigint,text) to authenticated;
grant execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  to authenticated;
grant execute on function public.save_article_draft_v2(uuid,text,text,text,text,text,jsonb,jsonb)
  to authenticated;
grant execute on function public.set_article_status(uuid,public.article_status,text)
  to authenticated;
grant execute on function public.set_article_status_v2(uuid,public.article_status,text)
  to authenticated;

revoke all on function private.save_article_draft_unmetered(
  uuid,text,text,text,text,text,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.save_course_draft_v2_unmetered(
  uuid,uuid,bigint,text,text,text,text,integer,jsonb,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.set_article_status_v2_unmetered(
  uuid,public.article_status,text
) from public, anon, authenticated, service_role;

comment on constraint tests_two_state_status on public.tests is
  'Only draft and published are valid lifecycle states; archived is permanently unsupported.';
comment on constraint articles_two_state_status on public.articles is
  'Only draft and published are valid lifecycle states; archived is permanently unsupported.';
