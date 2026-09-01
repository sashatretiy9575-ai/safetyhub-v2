-- Runtime rollout flags are private implementation details. A trigger WHEN
-- clause is evaluated as the statement invoker, so the original gated
-- triggers required service_role to execute private.runtime_feature_enabled
-- before their SECURITY DEFINER trigger functions could run. Keep the helper
-- uncallable and move each flag lookup inside the corresponding definer.

create or replace function private.emit_approval_requested_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
begin
  if not private.runtime_feature_enabled('notification_events') then
    return new;
  end if;
  if new.approval_state <> 'pending'
    or new.approval_requested_at is null
    or (
      old.approval_state = 'pending'
      and old.approval_requested_at is not distinct from new.approval_requested_at
    ) then
    return new;
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = new.user_id;
  if not found then
    return new;
  end if;

  insert into private.notification_events (
    event_type,
    aggregate_type,
    aggregate_id,
    dedupe_key,
    payload,
    occurred_at
  ) values (
    'account.approval_requested',
    'account',
    new.user_id,
    'approval:' || new.user_id::text || ':'
      || extract(epoch from new.approval_requested_at)::numeric(20,6)::text,
    jsonb_build_object(
      'userId', new.user_id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'locale', v_profile.preferred_locale,
      'requestedAt', new.approval_requested_at,
      'adminPath', '/admin/approvals'
    ),
    new.approval_requested_at
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function private.emit_course_completed_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_title text;
begin
  if not private.runtime_feature_enabled('notification_events') then
    return new;
  end if;
  if old.status is not distinct from new.status
    or new.status not in ('passed', 'failed') then
    return new;
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = new.user_id;
  select localization.title into v_title
  from public.test_revision_localizations localization
  where localization.revision_id = new.revision_id
    and localization.locale = new.locale;
  if v_profile.id is null or v_title is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'NOTIFICATION_EVENT_CONTEXT_MISSING';
  end if;

  insert into private.notification_events (
    event_type,
    aggregate_type,
    aggregate_id,
    dedupe_key,
    payload,
    occurred_at
  ) values (
    'course.completed',
    'attempt',
    new.id,
    'completion:' || new.id::text,
    jsonb_build_object(
      'attemptId', new.id,
      'userId', new.user_id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'locale', new.locale,
      'courseTitle', v_title,
      'result', new.status,
      'score', new.score,
      'total', (
        select variant.question_count
        from public.test_revision_variants variant
        where variant.id = new.variant_id
      ),
      'completedAt', new.completed_at,
      'adminPath', '/admin/attestations'
    ),
    coalesce(new.completed_at, statement_timestamp())
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;

create or replace function private.request_notification_dispatch_after_insert()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not private.runtime_feature_enabled('telegram_delivery') then
    return new;
  end if;
  perform private.request_notification_dispatch('after_commit', new.id);
  return new;
end;
$$;

drop trigger account_controls_emit_approval_notification
  on public.account_controls;
create trigger account_controls_emit_approval_notification
after update of approval_state, approval_requested_at
on public.account_controls
for each row
execute function private.emit_approval_requested_notification();

drop trigger test_attempts_emit_completion_notification
  on public.test_attempts;
create trigger test_attempts_emit_completion_notification
after update of status on public.test_attempts
for each row
execute function private.emit_course_completed_notification();

drop trigger notification_deliveries_request_dispatch
  on private.notification_deliveries;
create trigger notification_deliveries_request_dispatch
after insert on private.notification_deliveries
for each row
execute function private.request_notification_dispatch_after_insert();

-- Trigger execution does not require callers to receive EXECUTE on either the
-- trigger functions or their private flag reader.
revoke all on function private.runtime_feature_enabled(text),
  private.emit_approval_requested_notification(),
  private.emit_course_completed_notification(),
  private.request_notification_dispatch_after_insert()
from public, anon, authenticated, service_role;

comment on function private.runtime_feature_enabled(text) is
  'Private fail-closed flag reader. Trigger guards invoke it only from SECURITY DEFINER functions; browser and service roles receive no direct EXECUTE.';
