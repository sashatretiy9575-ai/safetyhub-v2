-- Deleting an account that had ever published an article failed with
-- «article_revisions_IMMUTABLE», and the bulk purge reported only
-- ACCOUNT_PURGE_FAILED, so nothing said which row refused.
--
-- `article_revisions.published_by` references `auth.users` with `on delete set
-- null`, so removing the account makes the database update a published revision,
-- and the immutability trigger refuses every update to one. The purge already
-- nulls `test_revisions.published_by` under a narrow exception written for
-- exactly this; the article table was left out of it.
--
-- The exception stays as narrow as it was: only during a purge, only the row of
-- the account being removed, only `published_by`, and only to null. Every other
-- change to a published revision is still refused, and a delete of one still is
-- unless the course or article itself is being deleted.
create or replace function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path to ''
as $$
declare
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
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
