begin;

-- A course draft destroyed by the blank browser editor must come back from its
-- published revision byte for byte, including the correct answers and every
-- identifier the KK/EN/ZH assessment translations are keyed by. A healthy draft
-- must be left alone, because it may hold unpublished editorial work.
do $contract$
declare
  v_test_id uuid;
  v_slug text;
  v_before jsonb;
  v_before_description text;
  v_after jsonb;
  v_receipt jsonb;
  v_untouched_before jsonb;
  v_untouched_after jsonb;
  v_untouched_id uuid;
  v_refused boolean := false;
begin
  select draft.test_id, draft.slug, draft.question_variants, draft.description
    into v_test_id, v_slug, v_before, v_before_description
  from public.course_drafts draft
  where private.course_question_variants_valid(draft.question_variants)
    and exists (
      select 1
      from public.test_revisions revision
      where revision.test_id = draft.test_id
        and revision.published_at is not null
    )
  order by draft.slug
  limit 1;
  if v_test_id is null then
    raise exception 'no published course with a complete draft bank to test against';
  end if;

  -- Reproduce the damage. The guard added by 20260903090000 exists precisely to
  -- stop this write, so it is disabled for the length of the simulation.
  alter table public.course_drafts disable trigger course_drafts_question_bank_guard;
  update public.course_drafts
  set question_variants = '[]'::jsonb, description = ''
  where test_id = v_test_id;
  alter table public.course_drafts enable trigger course_drafts_question_bank_guard;

  if private.course_question_variants_valid(
    (select question_variants from public.course_drafts where test_id = v_test_id)
  ) then
    raise exception 'the damage simulation did not invalidate the bank';
  end if;

  v_receipt := private.restore_course_draft_from_revision_unmetered(v_test_id, null);
  if coalesce((v_receipt ->> 'bankRestored')::boolean, false) is not true then
    raise exception 'the restore did not report a rebuilt bank';
  end if;

  select question_variants into v_after from public.course_drafts where test_id = v_test_id;
  if v_after is distinct from v_before then
    raise exception 'the restored bank differs from the destroyed one';
  end if;
  if (select description from public.course_drafts where test_id = v_test_id)
    is distinct from v_before_description then
    raise exception 'the restored description differs from the destroyed one';
  end if;

  -- course.draft_restored_from_revision is filtered out by the audit whitelist
  -- (20260905140000): the restore leaves no history row.
  if exists (
    select 1
    from public.admin_audit_log entry
    where entry.action = 'course.draft_restored_from_revision'
      and entry.target_id = v_test_id::text
  ) then
    raise exception 'the restore still writes to the action history';
  end if;

  -- A second run must not touch a bank that is now complete.
  select question_variants into v_untouched_before
  from public.course_drafts where test_id = v_test_id;
  v_receipt := private.restore_course_draft_from_revision_unmetered(v_test_id, null);
  if coalesce((v_receipt ->> 'bankRestored')::boolean, false) is not false then
    raise exception 'a complete bank was replaced anyway';
  end if;
  select question_variants into v_untouched_after
  from public.course_drafts where test_id = v_test_id;
  if v_untouched_after is distinct from v_untouched_before then
    raise exception 'a complete bank was modified by the restore';
  end if;

  -- A course with no published revision cannot be guessed at.
  select draft.test_id into v_untouched_id
  from public.course_drafts draft
  where not exists (
    select 1
    from public.test_revisions revision
    where revision.test_id = draft.test_id
      and revision.published_at is not null
  )
  limit 1;
  if v_untouched_id is not null then
    begin
      perform private.restore_course_draft_from_revision_unmetered(v_untouched_id, null);
    exception
      when no_data_found then v_refused := true;
    end;
    if not v_refused then
      raise exception 'a course without a published revision was restored anyway';
    end if;
  end if;

  -- The public entry point stays behind the capability gate.
  if exists (
    select 1
    from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'restore_course_draft_from_published_revision_v1'
      and grantee in ('anon', 'PUBLIC', 'service_role')
  ) then
    raise exception 'the restore entry point is granted too widely';
  end if;

  raise notice 'course draft restore verified for %', v_slug;
end;
$contract$;

rollback;
