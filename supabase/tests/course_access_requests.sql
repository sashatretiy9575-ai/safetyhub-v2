begin;

-- The course a person asked for reaches the administrator: a newcomer's with
-- their application, an approved person's as a «повторная заявка» of its own.
do $test$
declare
  v_newcomer uuid := '76000000-0000-4000-8000-000000000001';
  v_regular uuid := '76000000-0000-4000-8000-000000000002';
  v_test public.tests%rowtype;
  v_result jsonb;
  v_payload jsonb;
  v_now timestamptz := statement_timestamp();
begin
  if has_table_privilege('anon', 'public.course_access_requests', 'select')
    or has_table_privilege('authenticated', 'public.course_access_requests', 'select')
    or has_function_privilege('authenticated',
      'public.request_course_access_from_trusted_server(uuid,text)', 'execute')
    or not has_function_privilege('service_role',
      'public.request_course_access_from_trusted_server(uuid,text)', 'execute')
    or has_function_privilege('anon', 'public.dismiss_course_access_request(uuid,uuid)', 'execute') then
    raise exception 'course access request boundary invalid';
  end if;

  select * into v_test from public.tests where status = 'published' order by display_order, id limit 1;
  if not found then
    raise notice 'course access requests: no published course; skipping behaviour checks';
    return;
  end if;
  update private.runtime_feature_flags set enabled = true where feature_name = 'notification_events';
  update private.runtime_feature_flags set enabled = false where feature_name = 'telegram_delivery';

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
    ('00000000-0000-0000-0000-000000000000', v_newcomer, 'authenticated', 'authenticated',
     'course-request-newcomer@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now),
    ('00000000-0000-0000-0000-000000000000', v_regular, 'authenticated', 'authenticated',
     'course-request-regular@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now);
  update public.profiles set name = 'Айгерим', surname = 'Садыкова' where id = v_regular;
  update public.account_controls set approval_state = 'approved' where user_id = v_regular;

  -- An unknown course is not a request.
  if public.request_course_access_from_trusted_server(v_regular, 'no-such-course') ->> 'status' <> 'unknown' then
    raise exception 'an unknown course was recorded';
  end if;

  -- An approved person's request is news of its own, once.
  v_result := public.request_course_access_from_trusted_server(v_regular, v_test.slug);
  if v_result ->> 'status' <> 'requested' then raise exception 'repeat request refused: %', v_result; end if;
  select payload into v_payload from private.notification_events
  where event_type = 'course.access_requested' and aggregate_id = v_regular;
  if v_payload is null
    or v_payload ->> 'courseTitle' <> v_test.title
    or v_payload ->> 'surname' <> 'Садыкова'
    or v_payload ->> 'adminPath' <> '/admin/approvals'
    or (select array_agg(key order by key) from jsonb_object_keys(v_payload) key)
      <> array['adminPath','courseTitle','locale','name','requestedAt','surname','userId'] then
    raise exception 'repeat request notification is wrong: %', v_payload;
  end if;
  if public.request_course_access_from_trusted_server(v_regular, v_test.slug) ->> 'status' <> 'already_requested'
    or (select count(*) from private.notification_events
        where event_type = 'course.access_requested' and aggregate_id = v_regular) <> 1 then
    raise exception 'a second press notified the administrator again';
  end if;

  -- Opening the course answers the request.
  insert into public.course_access_grants (user_id, test_id) values (v_regular, v_test.id);
  if exists (select 1 from public.course_access_requests where user_id = v_regular) then
    raise exception 'an opened course left its request behind';
  end if;
  if public.request_course_access_from_trusted_server(v_regular, v_test.slug) ->> 'status' <> 'granted' then
    raise exception 'an open course was requested again';
  end if;

  -- A newcomer's course waits for the application, which then names it.
  if public.request_course_access_from_trusted_server(v_newcomer, v_test.slug) ->> 'status' <> 'requested'
    or exists (select 1 from private.notification_events
               where event_type = 'course.access_requested' and aggregate_id = v_newcomer) then
    raise exception 'a newcomer''s course was announced before the application';
  end if;
  update public.account_controls
  set approval_state = 'pending', approval_requested_at = v_now,
      approval_due_at = v_now + interval '24 hours'
  where user_id = v_newcomer;
  select payload into v_payload from private.notification_events
  where event_type = 'account.approval_requested' and aggregate_id = v_newcomer;
  if v_payload is null
    or (v_payload ->> 'schemaVersion')::int <> 3
    or v_payload -> 'courses' <> jsonb_build_array(v_test.title) then
    raise exception 'the application does not name the course: %', v_payload;
  end if;
end;
$test$;

-- An administrator opens a presentation without an application of their own;
-- a learner who has not been approved is still refused.
do $test$
declare
  v_admin uuid := '76000000-0000-4000-8000-000000000010';
  v_learner uuid := '76000000-0000-4000-8000-000000000011';
  v_slug text;
  v_message text;
  v_actor uuid;
begin
  select slug into v_slug from public.tests where status = 'published' order by display_order, id limit 1;
  if v_slug is null then return; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values
    ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
     'presentation-admin@safetyhub.invalid', '', now(), '{}', '{}', now(), now()),
    ('00000000-0000-0000-0000-000000000000', v_learner, 'authenticated', 'authenticated',
     'presentation-learner@safetyhub.invalid', '', now(), '{}', '{}', now(), now());
  update public.user_roles set product_role = 'admin' where user_id = v_admin;
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  foreach v_actor in array array[v_admin, v_learner] loop
    perform set_config('request.jwt.claim.sub', v_actor::text, true);
    perform set_config('request.jwt.claims',
      jsonb_build_object('role', 'authenticated', 'sub', v_actor)::text, true);
    v_message := 'ok';
    begin
      perform * from public.get_approved_course_presentation_locale(v_slug, 'presentation', 'ru');
    exception when others then
      v_message := sqlerrm;
    end;
    if v_actor = v_learner and v_message <> 'ACCOUNT_APPROVAL_REQUIRED' then
      raise exception 'an unapproved learner reached a presentation: %', v_message;
    end if;
    if v_actor = v_admin and v_message not in ('ok', 'PRESENTATION_NOT_FOUND') then
      raise exception 'an administrator was refused a presentation: %', v_message;
    end if;
  end loop;
end;
$test$;

rollback;
