-- Learner attempt payloads contain course questions. Approval therefore has to
-- be enforced in the database-facing RPCs, not only by a Next.js route or UI
-- redirect. `private.require_approved_learner()` also retains the active and
-- non-deleting-account checks while locking the control row for this statement.

create or replace function public.start_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  -- Keep authorization outside the envelope so browser callers receive the
  -- explicit ACCOUNT_APPROVAL_REQUIRED policy error rather than a generic
  -- mutation payload.
  perform private.require_approved_learner();
  perform private.enforce_actor_quota('attempt.start');
  begin
    v_result := private.start_test_attempt_unmetered(p_test_slug);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return private.rpc_error_envelope(sqlstate, sqlerrm, v_detail);
  end;
end;
$$;

create or replace function public.resume_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Keep a direct guard on this compatibility wrapper as well as on its
  -- start_test_attempt delegate, so future changes cannot accidentally turn
  -- resume into an approval bypass.
  perform private.require_approved_learner();
  return public.start_test_attempt(p_test_slug);
end;
$$;

create or replace function public.get_test_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_attempt public.test_attempts%rowtype;
begin
  v_user_id := private.require_approved_learner();
  select * into v_attempt
  from public.test_attempts
  where id = p_attempt_id and user_id = v_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'started' and v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = statement_timestamp()
    where id = v_attempt.id and status = 'started' and expires_at <= statement_timestamp();
  end if;
  return private.attempt_payload(v_attempt.id);
end;
$$;

create or replace function public.complete_test_attempt(
  p_attempt_id uuid, p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  -- As for start, a revoked/pending learner must not submit an answer set or
  -- receive a result payload after losing approval.
  perform private.require_approved_learner();
  perform private.enforce_actor_quota('attempt.complete');
  begin
    v_result := private.complete_test_attempt_unmetered(
      p_attempt_id, p_answers
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Preserve the existing authenticated learner contract while denying any
-- accidental PUBLIC/service-role execution path. Every one of these functions
-- derives the subject from auth.uid() inside the approval guard.
revoke execute on function public.start_test_attempt(text)
  from public, anon, service_role;
revoke execute on function public.resume_test_attempt(text)
  from public, anon, service_role;
revoke execute on function public.get_test_attempt(uuid)
  from public, anon, service_role;
revoke execute on function public.complete_test_attempt(uuid,jsonb)
  from public, anon, service_role;
grant execute on function public.start_test_attempt(text) to authenticated;
grant execute on function public.resume_test_attempt(text) to authenticated;
grant execute on function public.get_test_attempt(uuid) to authenticated;
grant execute on function public.complete_test_attempt(uuid,jsonb) to authenticated;

-- A table/column grant is independently reachable through PostgREST, so the
-- RPC guard above cannot be the sole protection for learner material. The
-- legacy `questions` bank and course `content` must never be readable by a
-- browser role: approved learners receive their assigned questions only from
-- the gated attempt RPCs. Keep the public catalogue's metadata projection so
-- anonymous course cards and SEO do not need a privileged server read.
--
-- `REVOKE SELECT ON TABLE` alone does not remove a prior column-level grant.
-- The explicit column revoke is required because earlier catalogue migrations
-- granted both fields to anon/authenticated.
revoke select on public.test_revisions from anon, authenticated;
revoke select (content, questions) on public.test_revisions from anon, authenticated;
grant select (
  id, test_id, version, slug, title, description, icon, display_order,
  presentation_id, seo, jurisdiction, effective_date, sources,
  question_count, duration_minutes, pass_score, attempts_per_calendar_day,
  attempt_reset_timezone, published_at
) on public.test_revisions to anon, authenticated;

comment on function public.start_test_attempt(text) is
  'Starts a learner attempt only for an active, manually approved account.';
comment on function public.resume_test_attempt(text) is
  'Resumes a learner attempt only for an active, manually approved account.';
comment on function public.get_test_attempt(uuid) is
  'Returns learner question payload only for an active, manually approved account.';
comment on function public.complete_test_attempt(uuid,jsonb) is
  'Completes a learner attempt only for an active, manually approved account.';
