-- Repairs course drafts that the empty browser editor destroyed, and gives an
-- administrator a way to repeat the repair without a database console.
--
-- The editor never loaded the saved question bank and minted 30 blank questions
-- on every open. features/admin/server.ts preserved the stored bank only while
-- all 30 were still blank, so typing a single question and pressing Save wrote a
-- blank bank over the real one. 20260903090000 stopped that from happening
-- again; this migration puts back what was already lost.
--
-- The published revision is the recovery source and it is complete: the learner
-- payload in public.test_revision_variants carries every question, option and
-- ordering, and private.test_revision_variant_answer_keys carries the matching
-- correct-option identifiers and explanations. Identifiers are preserved
-- verbatim, which also reattaches the KK/EN/ZH assessment translations that are
-- keyed by them.
--
-- The repair is deliberately conservative. A scalar field is restored only when
-- the draft's own value is blank, and the question bank only when the draft's
-- bank is invalid, so unpublished editorial work is never overwritten.

create function private.course_draft_bank_from_revision(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_agg(variant.payload order by variant.variant_number)
  from (
    select
      revision_variant.variant_number,
      jsonb_build_object(
        'id', revision_variant.stable_id,
        'variantNumber', revision_variant.variant_number,
        'questions', (
          select jsonb_agg(question.payload order by question.display_order)
          from (
            select
              (numbered_question.value ->> 'position')::integer as display_order,
              jsonb_build_object(
                'id', numbered_question.value ->> 'id',
                'text', numbered_question.value ->> 'text',
                'displayOrder', (numbered_question.value ->> 'position')::integer,
                'explanation', coalesce(
                  answer_key.explanations ->> (numbered_question.ordinality - 1)::integer,
                  ''
                ),
                'correctOptionId',
                  answer_key.correct_option_ids ->> (numbered_question.ordinality - 1)::integer,
                'options', (
                  select jsonb_agg(option.payload order by option.display_order)
                  from (
                    select
                      (revision_option.value ->> 'position')::integer as display_order,
                      jsonb_build_object(
                        'id', revision_option.value ->> 'id',
                        'text', revision_option.value ->> 'text',
                        'displayOrder', (revision_option.value ->> 'position')::integer
                      ) as payload
                    from jsonb_array_elements(numbered_question.value -> 'options')
                      as revision_option(value)
                  ) as option
                )
              ) as payload
            from jsonb_array_elements(revision_variant.questions)
              with ordinality as numbered_question(value, ordinality)
          ) as question
        )
      ) as payload
    from public.test_revision_variants revision_variant
    join private.test_revision_variant_answer_keys answer_key
      on answer_key.variant_id = revision_variant.id
    where revision_variant.revision_id = p_revision_id
  ) as variant;
$$;

revoke all on function private.course_draft_bank_from_revision(uuid)
  from public, anon, authenticated, service_role;

comment on function private.course_draft_bank_from_revision(uuid) is
  'Rebuilds the editor-shaped question bank of a published revision, keeping every question, option and answer identifier verbatim so localizations stay attached.';

create function private.restore_course_draft_from_revision_unmetered(
  p_test_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_draft public.course_drafts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_bank jsonb;
  v_restored_bank boolean := false;
  v_restored_fields text[] := '{}'::text[];
begin
  select * into v_draft
  from public.course_drafts draft
  where draft.test_id = p_test_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;

  select * into v_revision
  from public.test_revisions revision
  where revision.test_id = p_test_id
    and revision.published_at is not null
  order by revision.version desc
  limit 1;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'COURSE_NO_PUBLISHED_REVISION';
  end if;

  -- Only an unusable bank is replaced. A complete bank may hold unpublished
  -- editorial work and is left exactly as it is.
  if not private.course_question_variants_valid(v_draft.question_variants) then
    v_bank := private.course_draft_bank_from_revision(v_revision.id);
    if not private.course_question_variants_valid(v_bank) then
      raise exception using errcode = 'check_violation',
        message = 'COURSE_REVISION_BANK_UNUSABLE';
    end if;
    v_restored_bank := true;
  end if;

  update public.course_drafts draft
  set
    title = case
      when btrim(coalesce(draft.title, '')) = '' then v_revision.title else draft.title
    end,
    description = case
      when btrim(coalesce(draft.description, '')) = '' then v_revision.description
      else draft.description
    end,
    icon = case
      when btrim(coalesce(draft.icon, '')) = '' then v_revision.icon else draft.icon
    end,
    jurisdiction = case
      when btrim(coalesce(draft.jurisdiction, '')) = '' then v_revision.jurisdiction
      else draft.jurisdiction
    end,
    attempt_reset_timezone = case
      when btrim(coalesce(draft.attempt_reset_timezone, '')) = ''
        then v_revision.attempt_reset_timezone
      else draft.attempt_reset_timezone
    end,
    effective_date = coalesce(draft.effective_date, v_revision.effective_date),
    display_order = coalesce(draft.display_order, v_revision.display_order),
    presentation_id = coalesce(draft.presentation_id, v_revision.presentation_id),
    duration_minutes = coalesce(draft.duration_minutes, v_revision.duration_minutes),
    pass_score = coalesce(draft.pass_score, v_revision.pass_score),
    attempts_per_calendar_day = coalesce(
      draft.attempts_per_calendar_day, v_revision.attempts_per_calendar_day
    ),
    seo = case
      when draft.seo is null or draft.seo = '{}'::jsonb then v_revision.seo else draft.seo
    end,
    sources = case
      when draft.sources is null or draft.sources = '[]'::jsonb then v_revision.sources
      else draft.sources
    end,
    question_variants = case
      when v_restored_bank then v_bank else draft.question_variants
    end,
    draft_version = draft.draft_version + 1,
    updated_by = coalesce(p_actor_id, draft.updated_by),
    updated_at = now()
  where draft.test_id = p_test_id;

  if v_restored_bank then
    v_restored_fields := array_append(v_restored_fields, 'questionVariants');
  end if;
  if btrim(coalesce(v_draft.title, '')) = '' then
    v_restored_fields := array_append(v_restored_fields, 'title');
  end if;
  if btrim(coalesce(v_draft.description, '')) = '' then
    v_restored_fields := array_append(v_restored_fields, 'description');
  end if;

  -- Counts and field names only: the audit log is read by a wider admin surface
  -- than the editor and must never carry question text or answer keys.
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, before_data, after_data, reason
  ) values (
    p_actor_id,
    'course.draft_restored_from_revision',
    'test',
    p_test_id::text,
    jsonb_build_object(
      'draftVersion', v_draft.draft_version,
      'bankAvailable', private.course_question_variants_valid(v_draft.question_variants)
    ),
    jsonb_build_object(
      'draftVersion', v_draft.draft_version + 1,
      'revisionVersion', v_revision.version,
      'bankRestored', v_restored_bank,
      'restoredFields', to_jsonb(v_restored_fields)
    ),
    'Draft rebuilt from the published revision after the blank-editor data loss.'
  );

  return jsonb_build_object(
    'courseId', p_test_id,
    'revisionVersion', v_revision.version,
    'bankRestored', v_restored_bank,
    'restoredFields', to_jsonb(v_restored_fields)
  );
end;
$$;

revoke all on function private.restore_course_draft_from_revision_unmetered(uuid,uuid)
  from public, anon, authenticated, service_role;

comment on function private.restore_course_draft_from_revision_unmetered(uuid,uuid) is
  'Restores a course draft from its latest published revision. Replaces only an invalid question bank and only blank scalar fields, so unpublished work survives.';

create function public.restore_course_draft_from_published_revision_v1(
  p_actor_id uuid,
  p_test_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  return private.restore_course_draft_from_revision_unmetered(p_test_id, v_actor_id);
end;
$$;

revoke all on function public.restore_course_draft_from_published_revision_v1(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.restore_course_draft_from_published_revision_v1(uuid,uuid)
  to authenticated;

comment on function public.restore_course_draft_from_published_revision_v1(uuid,uuid) is
  'Audited recovery for a test.manage administrator: rebuilds a damaged course draft from its latest published revision without touching a complete bank.';

-- One-off repair of the damage already done. Every course whose draft bank is
-- unusable but which has a published revision is rebuilt from it; a healthy
-- draft is not touched, so this is a no-op on an unaffected database.
do $backfill$
declare
  v_test record;
  v_repaired integer := 0;
  v_skipped integer := 0;
begin
  for v_test in
    select draft.test_id, draft.slug
    from public.course_drafts draft
    where not private.course_question_variants_valid(draft.question_variants)
      and exists (
        select 1
        from public.test_revisions revision
        where revision.test_id = draft.test_id
          and revision.published_at is not null
      )
    order by draft.slug
  loop
    begin
      perform private.restore_course_draft_from_revision_unmetered(v_test.test_id, null);
      v_repaired := v_repaired + 1;
      raise notice 'course draft restored: %', v_test.slug;
    exception
      when others then
        -- A course whose published revision cannot produce a valid bank is left
        -- untouched and reported; it needs a content re-import, not a guess.
        v_skipped := v_skipped + 1;
        raise warning 'course draft not restorable: % (%)', v_test.slug, sqlerrm;
    end;
  end loop;

  raise notice 'course draft restore: % repaired, % skipped', v_repaired, v_skipped;
end;
$backfill$;
