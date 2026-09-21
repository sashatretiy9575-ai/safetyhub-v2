-- The course a person asked for travels with them to the administrator.
--
-- A newcomer clicks a course, signs up and waits for approval: the approval
-- queue now ticks that course by default, and the Telegram message names it.
-- A person who is already approved asks for one more course: that is a
-- different request — «повторная заявка» — with its own event, its own title
-- in the admin inbox and in Telegram, and its own list on /admin/approvals.
--
-- An open request is one row. Opening the course fulfils it (the row goes);
-- an administrator may also dismiss it.

create table public.course_access_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  requested_at timestamptz not null default statement_timestamp(),
  primary key (user_id, test_id)
);
create index course_access_requests_requested_at_idx
  on public.course_access_requests (requested_at, user_id);
create index course_access_requests_test_id_idx
  on public.course_access_requests (test_id);

alter table public.course_access_requests enable row level security;
revoke all on public.course_access_requests from public, anon, authenticated;
grant select, insert, delete on public.course_access_requests to service_role;

comment on table public.course_access_requests is
  'Курсы, к которым человек попросил доступ и которые ему ещё не открыли.';

-- A request is answered the moment the course is opened, whoever opens it and
-- however: the approval decision and the employee card both insert a grant.
create function private.fulfil_course_access_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.course_access_requests request
  where request.user_id = new.user_id and request.test_id = new.test_id;
  return new;
end;
$$;
revoke all on function private.fulfil_course_access_request() from public, anon, authenticated, service_role;

create trigger course_access_grants_fulfil_request
after insert on public.course_access_grants
for each row execute function private.fulfil_course_access_request();

alter table private.notification_events
  drop constraint notification_event_type;
alter table private.notification_events
  add constraint notification_event_type check (
    event_type in (
      'account.approval_requested',
      'course.access_requested',
      'course.completed',
      'system.alert'
    )
  );

-- Called by the server with the signed-in person's own id. Answers what the
-- course page should say next; never raises for an ordinary situation.
create function public.request_course_access_from_trusted_server(
  p_user_id uuid,
  p_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_state text;
  v_profile public.profiles%rowtype;
  v_requested_at timestamptz;
begin
  select * into v_test
  from public.tests test
  where test.slug = p_slug and test.status = 'published';
  if not found then
    return jsonb_build_object('status', 'unknown');
  end if;
  if exists (
    select 1 from public.course_access_grants grant_row
    where grant_row.user_id = p_user_id and grant_row.test_id = v_test.id
  ) then
    return jsonb_build_object('status', 'granted');
  end if;

  select control.approval_state::text into v_state
  from public.account_controls control
  where control.user_id = p_user_id
    and control.status = 'active'
    and not control.deletion_pending;
  if not found or v_state = 'rejected' then
    return jsonb_build_object('status', 'unavailable');
  end if;

  insert into public.course_access_requests (user_id, test_id)
  values (p_user_id, v_test.id)
  on conflict (user_id, test_id) do nothing
  returning requested_at into v_requested_at;
  if v_requested_at is null then
    return jsonb_build_object('status', 'already_requested');
  end if;

  -- A newcomer's course reaches the administrator with their application. Only
  -- an approved person's request is news of its own.
  if v_state = 'approved' and private.runtime_feature_enabled('notification_events') then
    select * into v_profile from public.profiles profile where profile.id = p_user_id;
    insert into private.notification_events (
      event_type, aggregate_type, aggregate_id, dedupe_key, payload, occurred_at
    ) values (
      'course.access_requested',
      'account',
      p_user_id,
      'course-access:' || p_user_id::text || ':' || v_test.id::text || ':'
        || extract(epoch from v_requested_at)::numeric(20,6)::text,
      jsonb_build_object(
        'userId', p_user_id,
        'name', coalesce(v_profile.name, ''),
        'surname', coalesce(v_profile.surname, ''),
        'locale', coalesce(v_profile.preferred_locale, 'ru'),
        'courseTitle', v_test.title,
        'requestedAt', to_char(v_requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'adminPath', '/admin/approvals'
      ),
      v_requested_at
    )
    on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('status', 'requested');
end;
$$;
revoke all on function public.request_course_access_from_trusted_server(uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_course_access_from_trusted_server(uuid, text)
  to service_role;

-- «Не открывать»: the administrator answers a request without opening the course.
create function public.dismiss_course_access_request(
  p_user_id uuid,
  p_test_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.require_capability('identity.manage');
  delete from public.course_access_requests request
  where request.user_id = p_user_id and request.test_id = p_test_id;
  return jsonb_build_object('dismissed', found);
end;
$$;
revoke all on function public.dismiss_course_access_request(uuid, uuid)
  from public, anon, service_role;
grant execute on function public.dismiss_course_access_request(uuid, uuid)
  to authenticated;

-- The application now names the courses the newcomer asked for. Without any,
-- the envelope stays the generic version 2 it always was.
create or replace function private.emit_approval_requested_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locale public.app_locale;
  v_courses jsonb;
  v_payload jsonb;
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

  select profile.preferred_locale into v_locale
  from public.profiles profile
  where profile.id = new.user_id;
  if not found then
    return new;
  end if;

  select coalesce(jsonb_agg(course.title order by request.requested_at, course.title), '[]'::jsonb)
  into v_courses
  from (
    select request.test_id, request.requested_at
    from public.course_access_requests request
    where request.user_id = new.user_id
    order by request.requested_at
    limit 10
  ) request
  join public.tests course on course.id = request.test_id;

  v_payload := jsonb_build_object(
    'schemaVersion', 2,
    'locale', v_locale,
    'requestedAt', to_char(
      new.approval_requested_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'adminPath', '/admin/approvals'
  );
  if jsonb_array_length(v_courses) > 0 then
    v_payload := v_payload || jsonb_build_object('schemaVersion', 3, 'courses', v_courses);
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
    v_payload,
    new.approval_requested_at
  )
  on conflict (dedupe_key) do nothing;
  return new;
end;
$$;
