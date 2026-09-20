-- The article fix of 20260920140000 uncovered the same shape three more times.
-- Published content and uploaded presentations all name the account that made
-- them, through a foreign key that clears itself when the account goes. Each of
-- those tables is protected against being edited after publication, and the
-- protection cannot tell that clearing the name is the database's own doing, so
-- deleting such an account failed — as PRESENTATION_IN_USE, then as the next
-- guard in line, and the bulk purge reported only ACCOUNT_PURGE_FAILED.
--
-- One predicate now says what a purge is allowed to do, and every guard asks it
-- the same question: during a purge, in the row of the account being removed,
-- one column may go to null and nothing else may change. Everything else about
-- these rows stays exactly as immutable as it was.
create function private.purge_clears_user_column(p_old jsonb, p_new jsonb, p_column text)
returns boolean
language sql
stable
set search_path to ''
as $$
  select coalesce(current_setting('safetyhub.purge_actor_id', true), '') <> ''
    and p_old - p_column = p_new - p_column
    and p_old ->> p_column = current_setting('safetyhub.purge_actor_id', true)
    and p_new -> p_column = 'null'::jsonb;
$$;
revoke all on function private.purge_clears_user_column(jsonb, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  v_content_delete text := coalesce(current_setting('safetyhub.content_delete', true), '');
begin
  if TG_OP = 'DELETE'
    and v_content_delete = '1'
    and (
      (TG_TABLE_SCHEMA = 'public'
        and TG_TABLE_NAME in ('test_revisions', 'article_revisions', 'test_revision_variants'))
      or (TG_TABLE_SCHEMA = 'private'
        and TG_TABLE_NAME in ('test_revision_answer_keys', 'test_revision_variant_answer_keys'))
    ) then
    return old;
  end if;
  if TG_OP = 'UPDATE'
    and TG_TABLE_SCHEMA = 'public'
    and TG_TABLE_NAME in ('test_revisions', 'article_revisions')
    and private.purge_clears_user_column(to_jsonb(old), to_jsonb(new), 'published_by') then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = TG_TABLE_NAME || '_IMMUTABLE';
end;
$$;

create or replace function private.protect_published_localization()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if coalesce(current_setting('safetyhub.content_delete', true), '') = '1' then
    return old;
  end if;
  if tg_op = 'UPDATE'
    and private.purge_clears_user_column(to_jsonb(old), to_jsonb(new), 'published_by') then
    return new;
  end if;
  raise exception using errcode = 'object_in_use',
    message = 'PUBLISHED_LOCALIZATION_IMMUTABLE';
end;
$$;

create or replace function private.protect_published_legal_localization()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if tg_op = 'DELETE' and old.status = 'published' then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE'
    and private.purge_clears_user_column(to_jsonb(old), to_jsonb(new), 'published_by') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'published' and (
    new.document_type,
    new.version,
    new.locale,
    new.title,
    new.body,
    new.body_hash,
    new.published_at,
    new.published_by
  ) is distinct from (
    old.document_type,
    old.version,
    old.locale,
    old.title,
    old.body,
    old.body_hash,
    old.published_at,
    old.published_by
  ) then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function private.protect_course_presentation_object()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if private.purge_clears_user_column(to_jsonb(old), to_jsonb(new), 'created_by') then
    return new;
  end if;
  if old.status in ('ready', 'retired')
    and new.course_id is distinct from old.course_id
    and not (
      old.status = 'retired'
      and new.course_id is null
      and coalesce(current_setting('safetyhub.content_delete', true), '') = '1'
    ) then
    raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
  end if;
  if old.status in ('ready', 'retired') and (
    new.storage_bucket, new.storage_path, new.thumbnail_path,
    new.source_filename, new.mime_type, new.byte_size, new.sha256,
    new.page_count, new.aspect_ratio, new.created_by, new.created_at,
    new.validated_at
  ) is distinct from (
    old.storage_bucket, old.storage_path, old.thumbnail_path,
    old.source_filename, old.mime_type, old.byte_size, old.sha256,
    old.page_count, old.aspect_ratio, old.created_by, old.created_at,
    old.validated_at
  ) then
    raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
  end if;
  if old.status = 'ready' and new.status not in ('ready', 'retired') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_IN_USE';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_IN_USE';
  end if;
  return new;
end;
$$;
