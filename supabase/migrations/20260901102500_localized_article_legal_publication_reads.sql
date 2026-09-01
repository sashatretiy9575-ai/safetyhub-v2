-- Locale-aware article publication/read contracts and atomic legal-copy release.

create function private.localized_article_content_hash(
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
  select private.article_content_hash_v2(
    lower(btrim(p_slug)),
    btrim(p_title),
    coalesce(btrim(p_description), ''),
    coalesce(btrim(p_cover_image), ''),
    p_blocks,
    p_seo,
    nullif(btrim(p_jurisdiction), ''),
    p_effective_date,
    p_sources
  )
$$;

create function private.assert_article_draft_localizations_complete(
  p_article_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_draft public.article_drafts%rowtype;
  v_source public.article_draft_localizations%rowtype;
begin
  select * into v_draft
  from public.article_drafts draft
  where draft.article_id = p_article_id;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'ARTICLE_DRAFT_NOT_FOUND';
  end if;

  if (
    select count(*)
    from public.article_draft_localizations localization
    where localization.article_id = p_article_id
      and localization.status = 'complete'
      and localization.reviewed_content_hash = localization.content_hash
  ) <> 4 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ARTICLE_LOCALIZATIONS_INCOMPLETE';
  end if;

  select * into v_source
  from public.article_draft_localizations localization
  where localization.article_id = p_article_id
    and localization.locale = 'ru';

  if v_source.title is distinct from v_draft.title
    or v_source.description is distinct from v_draft.description
    or v_source.blocks is distinct from v_draft.blocks
    or v_source.seo is distinct from v_draft.seo
    or v_source.sources is distinct from v_draft.sources
    or v_source.content_hash is distinct from v_draft.content_hash then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'ARTICLE_RU_LOCALIZATION_MISMATCH';
  end if;
end;
$$;

create function private.attach_article_revision_localizations(
  p_actor_id uuid,
  p_article_id uuid,
  p_revision_id uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_article_draft_localizations_complete(p_article_id);

  insert into public.article_revision_localizations (
    revision_id,
    locale,
    title,
    description,
    blocks,
    seo,
    sources,
    content_hash,
    translation_qa,
    published_by
  )
  select
    p_revision_id,
    localization.locale,
    localization.title,
    localization.description,
    localization.blocks,
    localization.seo,
    localization.sources,
    localization.content_hash,
    localization.translation_qa,
    p_actor_id
  from public.article_draft_localizations localization
  where localization.article_id = p_article_id
  on conflict (revision_id, locale) do nothing;

  if (
    select count(*)
    from public.article_revision_localizations localization
    where localization.revision_id = p_revision_id
  ) <> 4 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ARTICLE_LOCALIZATIONS_INCOMPLETE';
  end if;
end;
$$;

create function public.save_article_localization_draft(
  p_actor_id uuid,
  p_article_id uuid,
  p_locale public.app_locale,
  p_expected_version bigint,
  p_title text,
  p_description text,
  p_blocks jsonb,
  p_seo jsonb,
  p_sources jsonb,
  p_reviewed_content_hash text,
  p_translation_qa jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_draft public.article_drafts%rowtype;
  v_existing public.article_draft_localizations%rowtype;
  v_hash text;
  v_status text;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;

  begin
    if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200
      or char_length(coalesce(p_description, '')) > 2000
      or jsonb_typeof(p_blocks) is distinct from 'array'
      or jsonb_array_length(p_blocks) > 100
      or pg_column_size(p_blocks) > 262144
      or jsonb_typeof(p_seo) is distinct from 'object'
      or pg_column_size(p_seo) > 32768
      or jsonb_typeof(p_sources) is distinct from 'array'
      or pg_column_size(p_sources) > 131072
      or jsonb_typeof(p_translation_qa) is distinct from 'object'
      or pg_column_size(p_translation_qa) > 65536 then
      raise exception using errcode = 'check_violation',
        message = 'ARTICLE_LOCALIZATION_INVALID';
    end if;

    select * into v_draft
    from public.article_drafts draft
    where draft.article_id = p_article_id
    for share;
    if not found then
      raise exception using errcode = 'no_data_found',
        message = 'ARTICLE_DRAFT_NOT_FOUND';
    end if;

    if p_locale = 'ru' and (
      p_title is distinct from v_draft.title
      or coalesce(btrim(p_description), '') is distinct from v_draft.description
      or p_blocks is distinct from v_draft.blocks
      or p_seo is distinct from v_draft.seo
      or p_sources is distinct from v_draft.sources
    ) then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'ARTICLE_RU_LOCALIZATION_MISMATCH';
    end if;

    select * into v_existing
    from public.article_draft_localizations localization
    where localization.article_id = p_article_id
      and localization.locale = p_locale
    for update;
    if found and (
      p_expected_version is null
      or p_expected_version is distinct from v_existing.draft_version
    ) then
      raise exception using errcode = 'serialization_failure',
        message = 'ARTICLE_LOCALIZATION_CONFLICT';
    end if;
    if not found and p_expected_version is not null then
      raise exception using errcode = 'serialization_failure',
        message = 'ARTICLE_LOCALIZATION_CONFLICT';
    end if;

    v_hash := private.localized_article_content_hash(
      v_draft.slug,
      p_title,
      p_description,
      v_draft.cover_image,
      p_blocks,
      p_seo,
      v_draft.jurisdiction,
      v_draft.effective_date,
      p_sources
    );
    v_status := case
      when p_reviewed_content_hash = v_hash
        and coalesce(p_translation_qa ->> 'status', '') in ('passed', 'source')
      then 'complete'
      else 'draft'
    end;

    insert into public.article_draft_localizations (
      article_id,
      locale,
      title,
      description,
      blocks,
      seo,
      sources,
      content_hash,
      reviewed_content_hash,
      translation_qa,
      status,
      draft_version,
      updated_by
    ) values (
      p_article_id,
      p_locale,
      btrim(p_title),
      coalesce(btrim(p_description), ''),
      p_blocks,
      p_seo,
      p_sources,
      v_hash,
      case when v_status = 'complete' then v_hash else null end,
      p_translation_qa,
      v_status,
      1,
      v_actor_id
    )
    on conflict (article_id, locale) do update
    set title = excluded.title,
        description = excluded.description,
        blocks = excluded.blocks,
        seo = excluded.seo,
        sources = excluded.sources,
        content_hash = excluded.content_hash,
        reviewed_content_hash = excluded.reviewed_content_hash,
        translation_qa = excluded.translation_qa,
        status = excluded.status,
        draft_version = public.article_draft_localizations.draft_version + 1,
        updated_by = excluded.updated_by;

    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      v_actor_id,
      'article.localization_saved',
      'article_localization',
      p_article_id::text || ':' || p_locale::text,
      jsonb_build_object(
        'articleId', p_article_id,
        'locale', p_locale,
        'status', v_status,
        'contentHash', v_hash
      )
    );

    select * into v_existing
    from public.article_draft_localizations localization
    where localization.article_id = p_article_id
      and localization.locale = p_locale;

    return private.ensure_rpc_payload(jsonb_build_object(
      'articleId', p_article_id,
      'locale', p_locale,
      'status', v_existing.status,
      'draftVersion', v_existing.draft_version,
      'contentHash', v_existing.content_hash
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.publish_article_revision_v3(
  p_actor_id uuid,
  p_article_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_result jsonb;
  v_revision_id uuid;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;

  begin
    -- Lock the source and all localized drafts before the completeness check;
    -- otherwise a concurrent editor could change one language between the
    -- validator and the immutable revision inserts.
    perform 1
    from public.article_drafts draft
    where draft.article_id = p_article_id
    for update;
    perform 1
    from public.article_draft_localizations localization
    where localization.article_id = p_article_id
    order by localization.locale
    for update;

    perform private.assert_article_draft_localizations_complete(p_article_id);
    v_result := private.set_article_status_v2_unmetered(
      p_article_id,
      'published'::public.article_status,
      p_expected_content_hash
    );
    select article.current_revision_id into v_revision_id
    from public.articles article
    where article.id = p_article_id;
    if v_revision_id is null then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ARTICLE_REVISION_NOT_CREATED';
    end if;

    perform private.attach_article_revision_localizations(
      v_actor_id,
      p_article_id,
      v_revision_id
    );
    insert into public.admin_audit_log (
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      v_actor_id,
      'article.localizations_published',
      'article_revision',
      v_revision_id::text,
      jsonb_build_object(
        'articleId', p_article_id,
        'revisionId', v_revision_id,
        'locales', jsonb_build_array('ru', 'kk', 'en', 'zh')
      )
    );
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object(
        'revisionId', v_revision_id,
        'locales', jsonb_build_array('ru', 'kk', 'en', 'zh')
      )
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.get_article_editor_localizations(
  p_actor_id uuid,
  p_article_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_result jsonb;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'ACTOR_MISMATCH';
  end if;
  if not exists (
    select 1 from public.articles article where article.id = p_article_id
  ) then
    raise exception using errcode = 'no_data_found',
      message = 'ARTICLE_NOT_FOUND';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'locale', locales.locale,
    'status', coalesce(localization.status, 'missing'),
    'title', coalesce(localization.title, ''),
    'description', coalesce(localization.description, ''),
    'blocks', coalesce(localization.blocks, '[]'::jsonb),
    'seo', coalesce(localization.seo, '{}'::jsonb),
    'sources', coalesce(localization.sources, '[]'::jsonb),
    'contentHash', localization.content_hash,
    'reviewedContentHash', localization.reviewed_content_hash,
    'translationQa', coalesce(localization.translation_qa, '{}'::jsonb),
    'draftVersion', localization.draft_version
  ) order by array_position(enum_range(null::public.app_locale), locales.locale)), '[]'::jsonb)
  into v_result
  from unnest(enum_range(null::public.app_locale)) locales(locale)
  left join public.article_draft_localizations localization
    on localization.article_id = p_article_id
   and localization.locale = locales.locale;

  return jsonb_build_object(
    'articleId', p_article_id,
    'localizations', v_result
  );
end;
$$;

create function public.list_published_articles_locale(
  p_locale public.app_locale,
  p_limit integer default 20,
  p_before_published_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_limit not between 1 and 50
    or ((p_before_published_at is null) <> (p_before_id is null)) then
    raise exception using errcode = 'check_violation',
      message = 'ARTICLE_PAGE_INVALID';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'revisionId', page.revision_id,
    'slug', page.slug,
    'locale', page.locale,
    'title', page.title,
    'description', page.description,
    'coverImage', page.cover_image,
    'publishedAt', page.published_at,
    'effectiveDate', coalesce(page.effective_date::text, ''),
    'seo', page.seo
  ) order by page.published_at desc, page.id desc), '[]'::jsonb)
  into v_result
  from (
    select
      article.id,
      revision.id as revision_id,
      revision.slug,
      localization.locale,
      localization.title,
      localization.description,
      revision.cover_image,
      revision.published_at,
      revision.effective_date,
      localization.seo
    from public.articles article
    join public.article_revisions revision
      on revision.id = article.current_revision_id
    join public.article_revision_localizations localization
      on localization.revision_id = revision.id
     and localization.locale = p_locale
    where article.status = 'published'
      and article.is_published
      and (
        p_before_published_at is null
        or (revision.published_at, article.id) <
          (p_before_published_at, p_before_id)
      )
    order by revision.published_at desc, article.id desc
    limit p_limit
  ) page;

  return jsonb_build_object('items', v_result);
end;
$$;

create function public.get_published_article_locale(
  p_slug text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_slug is null
    or char_length(p_slug) not between 1 and 120
    or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception using errcode = 'no_data_found',
      message = 'ARTICLE_NOT_FOUND';
  end if;

  select jsonb_build_object(
    'id', article.id,
    'revisionId', revision.id,
    'slug', revision.slug,
    'locale', localization.locale,
    'title', localization.title,
    'description', localization.description,
    'coverImage', revision.cover_image,
    'blocks', localization.blocks,
    'seo', localization.seo,
    'jurisdiction', coalesce(revision.jurisdiction, ''),
    'effectiveDate', coalesce(revision.effective_date::text, ''),
    'sources', localization.sources,
    'publishedAt', revision.published_at
  )
  into v_result
  from public.articles article
  join public.article_revisions revision
    on revision.id = article.current_revision_id
  join public.article_revision_localizations localization
    on localization.revision_id = revision.id
   and localization.locale = p_locale
  where article.slug = p_slug
    and article.status = 'published'
    and article.is_published;

  if v_result is null then
    raise exception using errcode = 'no_data_found',
      message = 'ARTICLE_LOCALIZATION_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

create function public.stage_legal_document_version(
  p_document_type public.legal_document_type,
  p_version text,
  p_body_revision text,
  p_effective_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
begin
  perform private.enforce_actor_quota('content.article.mutate');
  if char_length(btrim(coalesce(p_version, ''))) not between 1 and 32
    or char_length(btrim(coalesce(p_body_revision, ''))) not between 3 and 160
    or p_effective_at is null then
    raise exception using errcode = 'check_violation',
      message = 'LEGAL_VERSION_INVALID';
  end if;

  insert into public.legal_document_versions (
    document_type, version, body_revision, effective_at, is_current
  ) values (
    p_document_type,
    btrim(p_version),
    btrim(p_body_revision),
    p_effective_at,
    false
  );

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'legal.version_staged',
    'legal_document',
    p_document_type::text || ':' || btrim(p_version),
    jsonb_build_object(
      'version', btrim(p_version),
      'bodyRevision', btrim(p_body_revision),
      'effectiveAt', p_effective_at
    )
  );

  return jsonb_build_object(
    'documentType', p_document_type,
    'version', btrim(p_version),
    'bodyRevision', btrim(p_body_revision),
    'effectiveAt', p_effective_at,
    'status', 'draft'
  );
end;
$$;

create or replace function public.save_legal_document_localization(
  p_document_type public.legal_document_type,
  p_version text,
  p_locale public.app_locale,
  p_title text,
  p_body jsonb,
  p_body_hash text,
  p_complete boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_row public.legal_document_localizations%rowtype;
  v_computed_hash text;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  v_computed_hash := case
    when jsonb_typeof(p_body) = 'object' then
      encode(
        extensions.digest(convert_to(p_body::text, 'UTF8'), 'sha256'),
        'hex'
      )
    else null
  end;
  if p_title is null
    or char_length(btrim(p_title)) not between 3 and 200
    or jsonb_typeof(p_body) is distinct from 'object'
    or pg_column_size(p_body) > 262144
    or (
      p_body_hash is not null
      and lower(btrim(p_body_hash)) is distinct from v_computed_hash
    ) then
    raise exception using errcode = 'check_violation',
      message = 'LEGAL_LOCALIZATION_INVALID';
  end if;

  insert into public.legal_document_localizations (
    document_type, version, locale, title, body, body_hash, status
  ) values (
    p_document_type,
    btrim(p_version),
    p_locale,
    btrim(p_title),
    p_body,
    v_computed_hash,
    case when p_complete then 'complete' else 'draft' end
  )
  on conflict (document_type, version, locale) do update
  set title = excluded.title,
      body = excluded.body,
      body_hash = excluded.body_hash,
      status = excluded.status,
      published_at = null,
      published_by = null
  where public.legal_document_localizations.status <> 'published'
  returning * into v_row;

  if v_row.locale is null then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'legal.localization_saved',
    'legal_document_localization',
    p_document_type::text || ':' || btrim(p_version) || ':' || p_locale::text,
    jsonb_build_object(
      'documentType', p_document_type,
      'version', btrim(p_version),
      'locale', p_locale,
      'status', v_row.status,
      'bodyHash', v_row.body_hash
    )
  );

  return jsonb_build_object(
    'type', v_row.document_type,
    'version', v_row.version,
    'locale', v_row.locale,
    'status', v_row.status,
    'bodyHash', v_row.body_hash
  );
end;
$$;

create function public.publish_legal_document_localizations(
  p_document_type public.legal_document_type,
  p_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_legal public.legal_document_versions%rowtype;
begin
  perform private.enforce_actor_quota('content.article.mutate');
  select * into v_legal
  from public.legal_document_versions legal
  where legal.document_type = p_document_type
    and legal.version = btrim(p_version)
  for share;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'LEGAL_VERSION_NOT_FOUND';
  end if;

  perform 1
  from public.legal_document_localizations localization
  where localization.document_type = p_document_type
    and localization.version = btrim(p_version)
  order by localization.locale
  for update;

  if (
    select count(*)
    from public.legal_document_localizations localization
    where localization.document_type = p_document_type
      and localization.version = btrim(p_version)
      and localization.status in ('complete', 'published')
      and localization.body_hash = encode(
        extensions.digest(convert_to(localization.body::text, 'UTF8'), 'sha256'),
        'hex'
      )
  ) <> 4 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_LOCALIZATIONS_INCOMPLETE';
  end if;

  perform set_config('safetyhub.legal_rotation', '1', true);
  update public.legal_document_versions
  set is_current = false
  where document_type = p_document_type
    and is_current
    and version <> btrim(p_version);
  update public.legal_document_versions
  set is_current = true
  where document_type = p_document_type
    and version = btrim(p_version)
    and not is_current;

  update public.legal_document_localizations
  set status = 'published',
      published_at = statement_timestamp(),
      published_by = v_actor_id
  where document_type = p_document_type
    and version = btrim(p_version)
    and status = 'complete';

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'legal.localizations_published',
    'legal_document',
    p_document_type::text || ':' || btrim(p_version),
    jsonb_build_object(
      'documentType', p_document_type,
      'version', btrim(p_version),
      'locales', jsonb_build_array('ru', 'kk', 'en', 'zh')
    )
  );

  return jsonb_build_object(
    'documentType', p_document_type,
    'version', btrim(p_version),
    'bodyRevision', v_legal.body_revision,
    'effectiveAt', v_legal.effective_at,
    'locales', jsonb_build_array('ru', 'kk', 'en', 'zh')
  );
end;
$$;

-- Keep the explicit RU locale row synchronized while the previous RU-only
-- editor is still serving requests during the rolling deployment.
create function private.sync_ru_article_draft_localization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.article_draft_localizations (
    article_id, locale, title, description, blocks, seo, sources,
    content_hash, reviewed_content_hash, translation_qa, status,
    draft_version, updated_by, created_at, updated_at
  ) values (
    new.article_id,
    'ru',
    new.title,
    new.description,
    new.blocks,
    new.seo,
    new.sources,
    new.content_hash,
    new.content_hash,
    jsonb_build_object('mode', 'source', 'locale', 'ru'),
    'complete',
    new.draft_version,
    new.updated_by,
    new.created_at,
    new.updated_at
  )
  on conflict (article_id, locale) do update
  set title = excluded.title,
      description = excluded.description,
      blocks = excluded.blocks,
      seo = excluded.seo,
      sources = excluded.sources,
      content_hash = excluded.content_hash,
      reviewed_content_hash = excluded.reviewed_content_hash,
      translation_qa = excluded.translation_qa,
      status = excluded.status,
      draft_version = excluded.draft_version,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at;
  return new;
end;
$$;

create trigger article_drafts_sync_ru_localization
after insert or update of title, description, blocks, seo, sources,
  content_hash, draft_version
on public.article_drafts
for each row execute function private.sync_ru_article_draft_localization();

-- Legacy article publication inserts the immutable revision before updating
-- `articles.current_revision_id`, which makes the latter a safe compatibility
-- hook for an explicit RU publication receipt.
create function private.sync_ru_article_revision_localization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision public.article_revisions%rowtype;
begin
  if new.current_revision_id is null
    or new.current_revision_id is not distinct from old.current_revision_id then
    return new;
  end if;
  select * into v_revision
  from public.article_revisions revision
  where revision.id = new.current_revision_id;
  if not found then
    return new;
  end if;

  insert into public.article_revision_localizations (
    revision_id, locale, title, description, blocks, seo, sources,
    content_hash, translation_qa, published_at, published_by
  ) values (
    v_revision.id,
    'ru',
    v_revision.title,
    v_revision.description,
    v_revision.blocks,
    v_revision.seo,
    v_revision.sources,
    v_revision.content_hash,
    jsonb_build_object('mode', 'source', 'locale', 'ru'),
    v_revision.published_at,
    v_revision.published_by
  )
  on conflict (revision_id, locale) do nothing;
  return new;
end;
$$;

create trigger articles_sync_ru_revision_localization
after update of current_revision_id on public.articles
for each row execute function private.sync_ru_article_revision_localization();

revoke all on function private.localized_article_content_hash(
  text,text,text,text,jsonb,jsonb,text,date,jsonb
), private.assert_article_draft_localizations_complete(uuid),
  private.attach_article_revision_localizations(uuid,uuid,uuid),
  private.sync_ru_article_draft_localization(),
  private.sync_ru_article_revision_localization()
from public, anon, authenticated, service_role;

revoke all on function public.save_article_localization_draft(
  uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,text,jsonb
), public.publish_article_revision_v3(uuid,uuid,text),
  public.get_article_editor_localizations(uuid,uuid),
  public.list_published_articles_locale(
    public.app_locale,integer,timestamptz,uuid
  ), public.get_published_article_locale(text,public.app_locale),
  public.stage_legal_document_version(
    public.legal_document_type,text,text,timestamptz
  ), public.publish_legal_document_localizations(
    public.legal_document_type,text
  )
from public, anon, authenticated, service_role;

grant execute on function public.save_article_localization_draft(
  uuid,uuid,public.app_locale,bigint,text,text,jsonb,jsonb,jsonb,text,jsonb
) to authenticated;
grant execute on function public.publish_article_revision_v3(uuid,uuid,text)
  to authenticated;
grant execute on function public.get_article_editor_localizations(uuid,uuid)
  to authenticated;
grant execute on function public.list_published_articles_locale(
  public.app_locale,integer,timestamptz,uuid
) to anon, authenticated;
grant execute on function public.get_published_article_locale(
  text,public.app_locale
) to anon, authenticated;
grant execute on function public.stage_legal_document_version(
  public.legal_document_type,text,text,timestamptz
) to authenticated;
grant execute on function public.publish_legal_document_localizations(
  public.legal_document_type,text
) to authenticated;

comment on function public.publish_article_revision_v3(uuid,uuid,text) is
  'Atomically publishes an article only when RU/KK/EN/ZH localized drafts are complete.';
comment on function public.publish_legal_document_localizations(
  public.legal_document_type,text
) is 'Atomically activates one canonical legal version and its four immutable localized copies.';
