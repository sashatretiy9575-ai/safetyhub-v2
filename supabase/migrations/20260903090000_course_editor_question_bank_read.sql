-- Two changes to the course editor, both requested by the product owner after
-- the empty editor turned out to be destroying data.
--
-- 1. An administrator holding `test.manage` may now read the saved question
--    bank of a course, including the correct-option identifiers. This reverses
--    the rule set by 20260831116000_retire_browser_editor_key_reads.sql for the
--    RU course editor only. The keys already sit in plain text in the operator's
--    own repository (content/snapshots/*/course.json, supabase/seed.sql), so the
--    boundary was protecting the operator from themselves rather than from an
--    attacker, while making a typo fix impossible. Every read is audited.
--    Deliberately NOT re-granted: get_course_editor_payload_v3, which also
--    returns immutable presentation storage paths. That boundary stands.
--
-- 2. A save can no longer replace a valid question bank with an invalid one.
--    The browser editor used to mint 30 blank questions on every open, and
--    features/admin/server.ts preserved the stored bank only when all 30 were
--    still blank -- so editing a single question wiped the other 29. A trigger
--    is used rather than a rewrite of save_course_draft_v3_unmetered because it
--    sees old and new under the same row lock and duplicates no logic.

create function private.guard_course_draft_question_bank()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.question_variants is distinct from old.question_variants
    and private.course_question_variants_valid(old.question_variants)
    and not private.course_question_variants_valid(new.question_variants) then
    raise exception using errcode = 'check_violation',
      message = 'COURSE_QUESTION_BANK_MISSING';
  end if;
  return new;
end;
$$;

revoke all on function private.guard_course_draft_question_bank()
  from public, anon, authenticated, service_role;

comment on function private.guard_course_draft_question_bank() is
  'Refuses to overwrite a complete course question bank with an incomplete one. A new course whose bank is still empty keeps its progressive-draft behaviour.';

create trigger course_drafts_question_bank_guard
before update on public.course_drafts
for each row execute function private.guard_course_draft_question_bank();

-- Narrow, audited editor read. It returns the bank and nothing else: no storage
-- paths, no policy duplication, no revision history.
create function public.read_course_question_bank_v4(
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
  v_draft public.course_drafts%rowtype;
  v_valid boolean;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;

  select * into v_draft
  from public.course_drafts draft
  where draft.test_id = p_test_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;

  v_valid := private.course_question_variants_valid(v_draft.question_variants);

  -- Counts and versions only. The audit log is read by a wider admin surface
  -- than the editor, so question text and answer keys must never land in it.
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'course.question_bank_read',
    'test',
    p_test_id::text,
    jsonb_build_object(
      'draftVersion', v_draft.draft_version,
      'contentHash', v_draft.content_hash,
      'bankAvailable', v_valid,
      'variantCount', case
        when jsonb_typeof(v_draft.question_variants) = 'array'
          then jsonb_array_length(v_draft.question_variants)
        else 0
      end
    )
  );

  return jsonb_build_object(
    'courseId', p_test_id,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'bankAvailable', v_valid,
    'questionVariants', case
      when v_valid then private.editor_course_question_variants(v_draft.question_variants)
      else '[]'::jsonb
    end
  );
end;
$$;

revoke all on function public.read_course_question_bank_v4(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.read_course_question_bank_v4(uuid,uuid) to authenticated;

comment on function public.read_course_question_bank_v4(uuid,uuid) is
  'Audited course-editor read of the saved question bank for a test.manage administrator. Emits the bank only when it is complete; never returns presentation storage paths.';
