begin;

create function pg_temp.selection_fixture() returns uuid language plpgsql as $$
declare
  learner uuid := gen_random_uuid();
  revision public.test_revisions;
  attempt public.test_attempts;
  result uuid;
begin
  select r.* into strict revision from public.tests t
    join public.test_revisions r on r.id = t.current_revision_id
    order by t.slug limit 1;
  insert into auth.users(instance_id,id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
  values('00000000-0000-0000-0000-000000000000',learner,'authenticated','authenticated',
    learner::text || '@selection-refresh.invalid','{}','{}',now(),now());
  update public.profiles set name='Тестовый',surname='Сотрудник',job='Рабочий',
    organization='Selection refresh fixture' where id=learner;
  insert into public.test_attempts(user_id,revision_id,test_id,variant_id,duration_minutes,
    pass_score,attempts_per_day,reset_timezone,status,answers,score,started_at,expires_at,completed_at,locale)
  select learner,revision.id,revision.test_id,v.id,revision.duration_minutes,
    revision.pass_score,revision.attempts_per_calendar_day,revision.attempt_reset_timezone,
    'passed',array_fill(1::smallint,array[v.question_count]),revision.pass_score,
    now()-interval '2 minutes',now()-interval '2 minutes'+make_interval(mins=>revision.duration_minutes),now(),'ru'
  from public.test_revision_variants v where v.revision_id=revision.id
    order by v.id limit 1 returning * into strict attempt;
  insert into public.attestations(user_id,revision_id,best_attempt_id,best_score,best_completed_at)
  values(learner,revision.id,attempt.id,attempt.score,attempt.completed_at) returning id into result;
  return result;
end;
$$;

do $test$
declare
  first_id uuid := pg_temp.selection_fixture();
  second_id uuid := pg_temp.selection_fixture();
  third_id uuid := pg_temp.selection_fixture();
  actor uuid;
  changed_user uuid;
  result jsonb;
  rejected boolean;
  bad_ids uuid[];
begin
  select user_id into actor from public.attestations where id=first_id;
  update public.user_roles set role='admin' where user_id=actor;
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.role','authenticated',true);
  result := public.refresh_admin_attestation_selection(array[first_id,second_id,first_id]);
  if (result->>'total')::int<>2 or (result->>'pendingIdentity')::int<>2
    or result->'recordIds' ? third_id::text then
    raise exception 'Fixed selection was expanded, duplicated or miscounted: %',result;
  end if;
  select user_id into changed_user from public.attestations where id=second_id;
  update public.profiles set organization='Moved after selection' where id=changed_user;
  update public.verified_identities set status='verified',version=1,name='Тестовый',
    surname='Сотрудник',job='Рабочий',organization='Moved after selection',verified_at=now()
    where user_id=changed_user;
  result := public.refresh_admin_attestation_selection(array[first_id,second_id]);
  if (result->>'total')::int<>2 or (result->>'pendingIdentity')::int<>1
    or (result->>'ready')::int<>1 or not (result->'recordIds' ? second_id::text)
    or result->'recordIds' ? third_id::text then
    raise exception 'Refresh did not retain exact IDs and update counters: %',result;
  end if;
  result := public.refresh_admin_attestation_selection(array[gen_random_uuid()]);
  if (result->>'total')::int<>0 or result->'recordIds'<>'[]'::jsonb then
    raise exception 'Unknown IDs selected other rows';
  end if;
  for bad_ids in select ids from (values
    (null::uuid[]), ('{}'::uuid[]), (array[null::uuid]),
    (array_fill(first_id,array[501]))
  ) invalid(ids) loop
    rejected := false;
    begin
      perform public.refresh_admin_attestation_selection(bad_ids);
    exception when sqlstate '22023' then rejected := true;
    end;
    if not rejected then raise exception 'Unbounded or invalid selection accepted'; end if;
  end loop;
  select user_id into actor from public.attestations where id=third_id;
  perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',actor)::text,true);
  perform set_config('request.jwt.claim.sub',actor::text,true);
  rejected := false;
  begin
    perform public.refresh_admin_attestation_selection(array[first_id]);
  exception when insufficient_privilege then rejected := true;
  end;
  if not rejected then raise exception 'Selection refresh bypassed results.read capability'; end if;
  if has_function_privilege('anon','public.refresh_admin_attestation_selection(uuid[])','execute')
    or has_function_privilege('service_role','public.refresh_admin_attestation_selection(uuid[])','execute')
    or not has_function_privilege('authenticated','public.refresh_admin_attestation_selection(uuid[])','execute') then
    raise exception 'Selection refresh grants changed its boundary';
  end if;
end;
$test$;

rollback;
