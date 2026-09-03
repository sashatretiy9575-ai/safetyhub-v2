-- Opening a course in the editor is no longer written to the action history.
--
-- The audit row was added with the bank read in 20260903090000 on the reasoning
-- that exposing correct answers deserved a trail. The owner, who is the only
-- reader of that history, asked for it to stop: the answers already sit in plain
-- text in their own repository, and a row per editor open buried the entries
-- that actually record a change. Every write still audits; only the read is now
-- silent.
--
-- The signature and return shape are unchanged, so the application needs no
-- coordinated release. Historical `course.question_bank_read` rows are left in
-- place; the action history keeps its label for them.

create or replace function public.read_course_question_bank_v4(
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
  'Course-editor read of the saved question bank for a test.manage administrator. Capability-gated and actor-checked; reads are not written to the action history. Never returns presentation storage paths.';
