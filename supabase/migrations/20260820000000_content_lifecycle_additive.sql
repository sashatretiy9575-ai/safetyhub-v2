-- Additive half of the two-state content lifecycle rollout. The previous app
-- remains usable while the v2 editor RPCs and deletion contracts are deployed.

alter table public.certificates
  add column if not exists course_deleted_at timestamptz;

alter table public.certificates
  alter column revision_id drop not null,
  alter column attestation_id drop not null,
  alter column attempt_id drop not null;

alter table public.certificates
  drop constraint if exists certificates_revision_id_fkey,
  drop constraint if exists certificates_attestation_id_fkey,
  drop constraint if exists certificates_attempt_id_fkey;

alter table public.certificates
  add constraint certificates_revision_id_fkey
    foreign key (revision_id) references public.test_revisions(id) on delete set null,
  add constraint certificates_attestation_id_fkey
    foreign key (attestation_id) references public.attestations(id) on delete set null,
  add constraint certificates_attempt_id_fkey
    foreign key (attempt_id) references public.test_attempts(id) on delete set null;

create or replace function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
  v_content_delete text := coalesce(current_setting('safetyhub.content_delete', true), '');
begin
  if TG_OP = 'DELETE'
    and v_content_delete = '1'
    and (
      (TG_TABLE_SCHEMA = 'public' and TG_TABLE_NAME in ('test_revisions', 'article_revisions'))
      or (TG_TABLE_SCHEMA = 'private' and TG_TABLE_NAME = 'test_revision_answer_keys')
    ) then
    return old;
  end if;
  if TG_OP = 'UPDATE'
    and TG_TABLE_SCHEMA = 'public'
    and TG_TABLE_NAME = 'test_revisions'
    and v_purge_actor <> ''
    and to_jsonb(new) - 'published_by' = to_jsonb(old) - 'published_by'
    and to_jsonb(old) ->> 'published_by' = v_purge_actor
    and to_jsonb(new) -> 'published_by' = 'null'::jsonb then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = TG_TABLE_NAME || '_IMMUTABLE';
end;
$$;

-- Optional source metadata is content too: changing only jurisdiction,
-- effective date, or sources must produce a draft that differs from the
-- currently published snapshot.
create or replace function private.course_content_hash_v2(
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb,
  p_jurisdiction text,
  p_effective_date date,
  p_sources jsonb
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
    'seo', p_seo,
    'jurisdiction', coalesce(p_jurisdiction, ''),
    'effectiveDate', coalesce(p_effective_date::text, ''),
    'sources', coalesce(p_sources, '[]'::jsonb)
  )::text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function private.article_content_hash_v2(
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_seo jsonb,
  p_jurisdiction text,
  p_effective_date date,
  p_sources jsonb
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
    'seo', p_seo,
    'jurisdiction', coalesce(p_jurisdiction, ''),
    'effectiveDate', coalesce(p_effective_date::text, ''),
    'sources', coalesce(p_sources, '[]'::jsonb)
  )::text, 'utf8'), 'sha256'), 'hex');
$$;

create or replace function private.save_article_draft_v2_unmetered(
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
  v_jurisdiction text;
  v_effective_date date;
  v_hash text;
begin
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 120
    or char_length(btrim(p_title)) not between 3 and 200
    or char_length(coalesce(p_description, '')) > 1000
    or char_length(coalesce(p_cover_image, '')) > 2048
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
  v_jurisdiction := nullif(btrim(p_content_metadata ->> 'jurisdiction'), '');
  v_effective_date := nullif(p_content_metadata ->> 'effectiveDate', '')::date;
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
    v_jurisdiction, v_effective_date, v_sources
  );

  if p_article_id is null then
    if exists (
      select 1 from public.articles article where article.slug = v_slug
    ) or exists (
      select 1 from public.article_drafts draft where draft.slug = v_slug
    ) or exists (
      select 1 from public.article_slug_redirects redirect where redirect.old_slug = v_slug
    ) then
      raise exception using errcode = 'unique_violation', message = 'ARTICLE_SLUG_TAKEN';
    end if;
    insert into public.articles (
      slug, title, description, cover_image, blocks, seo, status,
      is_published, content_hash, created_by, updated_by,
      jurisdiction, effective_date, sources
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), '[]'::jsonb, v_seo, 'draft',
      false, v_hash, v_actor_id, v_actor_id,
      v_jurisdiction, v_effective_date, v_sources
    ) returning * into v_article;
    insert into public.article_drafts (
      article_id, slug, title, description, cover_image, blocks, seo,
      jurisdiction, effective_date, sources, content_hash, updated_by
    ) values (
      v_article.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), p_blocks, v_seo,
      v_jurisdiction, v_effective_date, v_sources, v_hash, v_actor_id
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
    if v_slug <> v_draft.slug and (
      exists (
        select 1 from public.articles other
        where other.id <> p_article_id and other.slug = v_slug
      ) or exists (
        select 1 from public.article_drafts other
        where other.article_id <> p_article_id and other.slug = v_slug
      ) or exists (
        select 1 from public.article_slug_redirects redirect
        where redirect.old_slug = v_slug and redirect.article_id <> p_article_id
      )
    ) then
      raise exception using errcode = 'unique_violation', message = 'ARTICLE_SLUG_TAKEN';
    end if;
    update public.article_drafts
    set slug = v_slug,
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        cover_image = coalesce(btrim(p_cover_image), ''),
        blocks = p_blocks,
        seo = v_seo,
        jurisdiction = v_jurisdiction,
        effective_date = v_effective_date,
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
      where id = p_article_id
      returning * into v_article;
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
    v_result := private.save_article_draft_v2_unmetered(
      p_article_id, p_original_slug, p_slug, p_title, p_description,
      p_cover_image, p_blocks, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

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

-- Saving and publishing is one PostgreSQL transaction. If publication loses
-- an optimistic-concurrency race, the preceding draft save is rolled back by
-- this function's exception block as well.
create or replace function public.save_and_publish_article_v2(
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
  v_saved jsonb;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    v_saved := private.save_article_draft_v2_unmetered(
      p_article_id, p_original_slug, p_slug, p_title, p_description,
      p_cover_image, p_blocks, p_content_metadata
    );
    v_result := private.set_article_status_v2_unmetered(
      (v_saved ->> 'id')::uuid,
      'published'::public.article_status,
      v_saved ->> 'contentHash'
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function private.save_course_draft_v2_unmetered(
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
    if exists (
      select 1 from public.tests test where test.slug = v_slug
    ) or exists (
      select 1 from public.course_drafts draft where draft.slug = v_slug
    ) or exists (
      select 1 from public.course_slug_redirects redirect where redirect.old_slug = v_slug
    ) then
      raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
    end if;
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
    if v_slug <> v_draft.slug and (
      exists (
        select 1 from public.tests other
        where other.id <> p_test_id and other.slug = v_slug
      ) or exists (
        select 1 from public.course_drafts other
        where other.test_id <> p_test_id and other.slug = v_slug
      ) or exists (
        select 1 from public.course_slug_redirects redirect
        where redirect.old_slug = v_slug and redirect.test_id <> p_test_id
      )
    ) then
      raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
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
  return jsonb_build_object(
    'id', v_test_id,
    'slug', v_draft.slug,
    'status', case when v_test.status = 'published' then 'published' else 'draft' end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  );
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

create or replace function private.publish_course_revision_v2_unmetered(
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
  if v_draft.content_hash is distinct from p_expected_content_hash then
    raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
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
    content_hash, jurisdiction, effective_date, sources, questions,
    question_count, duration_minutes, pass_score, published_by
  ) values (
    v_revision_id, v_test.id, v_version, v_draft.slug, v_draft.title,
    v_draft.description, v_draft.icon, v_draft.content, v_draft.seo,
    v_draft.content_hash, v_draft.jurisdiction, v_draft.effective_date,
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
    delete from public.course_slug_redirects
    where old_slug = v_draft.slug and test_id = v_test.id;
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
      sources = v_draft.sources,
      content_hash = v_draft.content_hash,
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

create or replace function public.publish_course_revision_v2(
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

create or replace function public.save_and_publish_course_v2(
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
  v_saved jsonb;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_saved := private.save_course_draft_v2_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
      p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
    );
    v_result := private.publish_course_revision_v2_unmetered(
      p_actor_id,
      (v_saved ->> 'id')::uuid,
      v_saved ->> 'contentHash'
    );
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object('draftVersion', (v_saved ->> 'draftVersion')::bigint)
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.get_test_editor_payload_v2(p_actor_id uuid, p_test_id uuid)
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

create or replace function private.guard_certificate_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attestation public.attestations%rowtype;
  v_revision public.test_revisions%rowtype;
  v_identity public.verified_identities%rowtype;
  v_predecessor public.certificates%rowtype;
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
  v_content_delete text := coalesce(current_setting('safetyhub.content_delete', true), '');
begin
  if TG_OP = 'UPDATE' then
    if v_content_delete = '1'
      and old.course_deleted_at is null
      and new.course_deleted_at is not null
      and new.revision_id is null
      and new.attestation_id is null
      and new.attempt_id is null
      and to_jsonb(new) - array['revision_id','attestation_id','attempt_id','course_deleted_at']
        = to_jsonb(old) - array['revision_id','attestation_id','attempt_id','course_deleted_at'] then
      return new;
    end if;
    if v_purge_actor <> ''
      and to_jsonb(new) - array['issued_by','revoked_by']
        = to_jsonb(old) - array['issued_by','revoked_by']
      and new.issued_by is not distinct from (
        case when old.issued_by::text = v_purge_actor then null else old.issued_by end
      )
      and new.revoked_by is not distinct from (
        case when old.revoked_by::text = v_purge_actor then null else old.revoked_by end
      ) then
      return new;
    end if;
    if (new.id, new.certificate_number, new.user_id, new.revision_id,
        new.attestation_id, new.attempt_id, new.identity_version, new.full_name,
        new.job, new.organization, new.test_slug, new.test_title, new.score,
        new.total, new.pass_score, new.best_completed_at, new.issued_at,
        new.issued_by, new.issue_source, new.supersedes_certificate_id,
        new.template_version, new.course_deleted_at)
      is distinct from
       (old.id, old.certificate_number, old.user_id, old.revision_id,
        old.attestation_id, old.attempt_id, old.identity_version, old.full_name,
        old.job, old.organization, old.test_slug, old.test_title, old.score,
        old.total, old.pass_score, old.best_completed_at, old.issued_at,
        old.issued_by, old.issue_source, old.supersedes_certificate_id,
        old.template_version, old.course_deleted_at) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_SNAPSHOT_IMMUTABLE';
    end if;
    if old.revoked_at is not null
      and (new.revoked_at, new.revoked_by, new.revoke_reason)
        is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_REVOCATION_IMMUTABLE';
    end if;
    if new.revoked_at is null
      and (new.revoked_by is not null or new.revoke_reason is not null) then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_REVOCATION_INVALID';
    end if;
    if new.revoked_at is not null and char_length(coalesce(new.revoke_reason, '')) < 3 then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_REVOKE_REASON_REQUIRED';
    end if;
    return new;
  end if;

  select * into v_attestation from public.attestations where id = new.attestation_id;
  select * into v_revision from public.test_revisions where id = new.revision_id;
  select * into v_identity from public.verified_identities where user_id = new.user_id;
  if v_attestation.id is null or v_revision.id is null
    or v_attestation.user_id <> new.user_id
    or v_attestation.revision_id <> new.revision_id
    or v_attestation.best_attempt_id <> new.attempt_id
    or v_attestation.best_score <> new.score
    or v_attestation.best_completed_at <> new.best_completed_at
    or v_revision.question_count <> new.total
    or v_revision.pass_score <> new.pass_score
    or v_revision.slug <> new.test_slug
    or v_revision.title <> new.test_title
    or new.score < new.pass_score
    or v_identity.status <> 'verified'
    or v_identity.version <> new.identity_version
    or concat_ws(' ', v_identity.name, v_identity.surname) <> new.full_name
    or v_identity.job <> new.job
    or v_identity.organization <> new.organization then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CERTIFICATE_SNAPSHOT_INVALID';
  end if;
  if new.issue_source = 'manual' and new.supersedes_certificate_id is not null then
    raise exception using errcode = 'check_violation', message = 'CERTIFICATE_LINEAGE_INVALID';
  end if;
  if new.issue_source <> 'manual' then
    if new.supersedes_certificate_id is null then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_PREDECESSOR_REQUIRED';
    end if;
    select * into v_predecessor
    from public.certificates where id = new.supersedes_certificate_id;
    if v_predecessor.id is null
      or v_predecessor.user_id <> new.user_id
      or v_predecessor.revision_id <> new.revision_id
      or v_predecessor.revoked_at is null then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_LINEAGE_INVALID';
    end if;
    if new.issue_source = 'score_improvement' and new.score <= v_predecessor.score then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_SCORE_IMPROVEMENT_REQUIRED';
    end if;
    if new.issue_source = 'identity_correction'
      and (new.attestation_id <> v_predecessor.attestation_id
        or new.score <> v_predecessor.score
        or new.identity_version <= v_predecessor.identity_version) then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_IDENTITY_CORRECTION_INVALID';
    end if;
    if exists (
      select 1
      from public.certificates newer_predecessor
      where newer_predecessor.user_id = new.user_id
        and newer_predecessor.revision_id = new.revision_id
        and newer_predecessor.revoked_at is not null
        and (newer_predecessor.issued_at, newer_predecessor.id)
          > (v_predecessor.issued_at, v_predecessor.id)
    ) then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_PREDECESSOR_NOT_LATEST';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.delete_course(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint
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
  v_asset_ids uuid[] := '{}'::uuid[];
  v_certificate_count integer;
  v_deleted_at timestamptz := statement_timestamp();
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  begin
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

  select coalesce(array_agg(distinct usage.asset_id), '{}'::uuid[])
  into v_asset_ids
  from public.content_asset_usages usage
  where usage.owner_id = p_test_id
    and usage.owner_type in ('course_draft', 'course_revision');

  select count(*) into v_certificate_count
  from public.certificates certificate
  where certificate.revision_id in (
    select revision.id from public.test_revisions revision where revision.test_id = p_test_id
  );

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, before_data
  ) values (
    v_actor_id, 'test', p_test_id::text, 'course.deleted',
    jsonb_build_object(
      'slug', v_test.slug,
      'contentVersion', v_test.content_version,
      'preservedCertificates', v_certificate_count
    )
  );

  perform set_config('safetyhub.content_delete', '1', true);
  update public.certificates certificate
  set revision_id = null,
      attestation_id = null,
      attempt_id = null,
      course_deleted_at = v_deleted_at
  where certificate.revision_id in (
    select revision.id from public.test_revisions revision where revision.test_id = p_test_id
  );

  delete from public.content_asset_usages
  where owner_id = p_test_id
    and owner_type in ('course_draft', 'course_revision');
  delete from public.tests where id = p_test_id;

  update public.content_assets asset
  set status = 'orphan_candidate'
  where asset.id = any(v_asset_ids)
    and not exists (
      select 1 from public.content_asset_usages usage where usage.asset_id = asset.id
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'id', p_test_id,
      'slug', v_test.slug,
      'deleted', true,
      'preservedCertificates', v_certificate_count
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.delete_article(
  p_article_id uuid,
  p_expected_version bigint
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
  v_asset_ids uuid[] := '{}'::uuid[];
begin
  perform private.enforce_actor_quota('content.article.mutate');
  begin
    select * into v_article from public.articles where id = p_article_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'ARTICLE_NOT_FOUND';
    end if;
    select * into v_draft from public.article_drafts where article_id = p_article_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'ARTICLE_DRAFT_NOT_FOUND';
    end if;
    if p_expected_version is null or v_draft.draft_version <> p_expected_version then
      raise exception using errcode = 'serialization_failure', message = 'ARTICLE_DRAFT_CONFLICT';
    end if;

  select coalesce(array_agg(distinct usage.asset_id), '{}'::uuid[])
  into v_asset_ids
  from public.content_asset_usages usage
  where usage.owner_id = p_article_id
    and usage.owner_type in ('article_draft', 'article_revision');

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, before_data
  ) values (
    v_actor_id, 'article', p_article_id::text, 'article.deleted',
    jsonb_build_object('slug', v_article.slug, 'contentVersion', v_article.content_version)
  );

  perform set_config('safetyhub.content_delete', '1', true);
  delete from public.content_asset_usages
  where owner_id = p_article_id
    and owner_type in ('article_draft', 'article_revision');
  delete from public.articles where id = p_article_id;

  update public.content_assets asset
  set status = 'orphan_candidate'
  where asset.id = any(v_asset_ids)
    and not exists (
      select 1 from public.content_asset_usages usage where usage.asset_id = asset.id
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'id', p_article_id,
      'slug', v_article.slug,
      'deleted', true
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;
