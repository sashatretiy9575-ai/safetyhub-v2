begin;

-- Organization search: three normalized characters, at most eight names, a
-- per-account budget, substring matching kept.
do $test$
declare
  v_user uuid := '7e260000-0000-4000-8000-000000000001';
  v_now timestamptz := statement_timestamp();
  v_names text[];
  v_consumed integer;
  v_blocked boolean;
  v_index integer;
begin
  if (select provolatile from pg_proc
      where oid = 'public.search_profile_organizations(text,integer)'::regprocedure) <> 'v' then
    raise exception 'organization search must be VOLATILE: it writes its quota row';
  end if;
  if has_function_privilege('anon', 'public.search_profile_organizations(text,integer)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.search_profile_organizations(text,integer)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.search_profile_organizations(text,integer)', 'EXECUTE') then
    raise exception 'organization search privilege boundary changed';
  end if;
  if (select (quota, window_seconds) from private.quota_policy('profile.organization.search'))
      is distinct from (60, 300)
    or (select (quota, window_seconds) from private.quota_policy('admin.pii.read'))
      is distinct from (120, 600)
    -- The restated catalog kept the tariffs it already had.
    or (select (quota, window_seconds) from private.quota_policy('profile.update'))
      is distinct from (30, 300)
    or (select (quota, window_seconds) from private.quota_policy('admin.read.query'))
      is distinct from (30, 60)
    or (select (quota, window_seconds) from private.quota_policy('certificate.export.download'))
      is distinct from (30, 300)
    or (select quota from private.quota_policy('unknown.action')) is not null then
    raise exception 'quota catalog is wrong after the September 26 additions';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values (
    '00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
    'org-search-sept26@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now
  );
  -- A fresh sign-up: profile incomplete, not approved. It may search, within
  -- the limits below.
  insert into public.organizations (canonical_name, normalized_key)
  select 'ТОО Зенитпроба ' || lpad(n::text, 2, '0'),
    private.normalize_organization_key('ТОО Зенитпроба ' || lpad(n::text, 2, '0'))
  from generate_series(1, 12) n;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('role', 'authenticated', 'sub', v_user)::text, true);

  -- Fewer than three normalized characters: nothing, and no budget spent.
  if public.search_profile_organizations('', 8) <> '{}'::text[]
    or public.search_profile_organizations('зе', 20) <> '{}'::text[]
    or public.search_profile_organizations('  «З»  ', 20) <> '{}'::text[]
    or public.search_profile_organizations('%_', 20) <> '{}'::text[] then
    raise exception 'a query shorter than three characters returned names';
  end if;
  if exists (select 1 from private.business_rate_limits
             where actor_id = v_user and action = 'profile.organization.search') then
    raise exception 'a refused short query spent the search budget';
  end if;

  -- Eight names at most, whatever the caller asks for.
  v_names := public.search_profile_organizations('зенитпроба', 20);
  if cardinality(v_names) <> 8 then
    raise exception 'organization search returned % names instead of 8', cardinality(v_names);
  end if;
  -- Substring, not prefix: the middle of a word inside «ТОО …» still matches.
  v_names := public.search_profile_organizations('итпроба 1', 8);
  if not v_names @> array['ТОО Зенитпроба 10', 'ТОО Зенитпроба 11', 'ТОО Зенитпроба 12'] then
    raise exception 'substring match lost: %', v_names;
  end if;

  select consumed into v_consumed from private.business_rate_limits
  where actor_id = v_user and action = 'profile.organization.search';
  if v_consumed is distinct from 2 then
    raise exception 'organization search spent % units for 2 searches', v_consumed;
  end if;

  -- An exhausted budget refuses the next search.
  update private.business_rate_limits
  set consumed = 60, window_started_at = statement_timestamp()
  where actor_id = v_user and action = 'profile.organization.search';
  v_blocked := false;
  begin
    perform public.search_profile_organizations('зенитпроба', 8);
  exception when program_limit_exceeded then
    v_blocked := sqlerrm like 'RATE_LIMITED:%';
  end;
  if not v_blocked then
    raise exception 'organization search ignored an exhausted budget';
  end if;
  -- A short query still answers empty without touching the exhausted budget.
  if public.search_profile_organizations('зе', 8) <> '{}'::text[] then
    raise exception 'short query changed under an exhausted budget';
  end if;

  -- A suspended account is refused before the length check.
  update public.account_controls set status = 'suspended' where user_id = v_user;
  v_blocked := false;
  begin
    perform public.search_profile_organizations('з', 8);
  exception when insufficient_privilege then
    v_blocked := sqlerrm = 'ACCOUNT_UNAVAILABLE';
  end;
  if not v_blocked then
    raise exception 'a suspended account reached organization search';
  end if;

  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$test$;

-- Sign-out revocation: a token that names a GoTrue session works only while
-- that session exists.
do $test$
declare
  v_user uuid := '7e260000-0000-4000-8000-000000000011';
  v_other uuid := '7e260000-0000-4000-8000-000000000012';
  v_admin uuid := '7e260000-0000-4000-8000-000000000013';
  v_session uuid := '7e260000-0000-4000-8000-0000000000a1';
  v_other_session uuid := '7e260000-0000-4000-8000-0000000000a2';
  v_admin_session uuid := '7e260000-0000-4000-8000-0000000000a3';
  v_now timestamptz := statement_timestamp();
  v_message text;
  v_rows integer;
begin
  if has_function_privilege('authenticated', 'private.zh_session_epoch_is_current(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'private.zh_session_epoch_is_current(uuid)', 'EXECUTE')
    or has_function_privilege('service_role', 'private.zh_session_epoch_is_current(uuid)', 'EXECUTE') then
    raise exception 'session binding check became callable by an API role';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) values
    ('00000000-0000-0000-0000-000000000000', v_user, 'authenticated', 'authenticated',
     'signout-user-sept26@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now),
    ('00000000-0000-0000-0000-000000000000', v_other, 'authenticated', 'authenticated',
     'signout-other-sept26@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now),
    ('00000000-0000-0000-0000-000000000000', v_admin, 'authenticated', 'authenticated',
     'signout-admin-sept26@safetyhub.invalid', '', v_now, '{}', '{}', v_now, v_now);
  update public.user_roles set product_role = 'admin' where user_id = v_admin;
  insert into auth.sessions (id, user_id, created_at, updated_at, aal) values
    (v_session, v_user, v_now, v_now, 'aal1'),
    (v_other_session, v_other, v_now, v_now, 'aal1'),
    (v_admin_session, v_admin, v_now, v_now, 'aal1');

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  -- A live session: the request is served.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user, 'session_id', v_session)::text, true);
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 1 or private.require_active_user() <> v_user then
    raise exception 'a live session was refused';
  end if;

  -- Somebody else's session id does not stand in for the caller's own.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user, 'session_id', v_other_session)::text, true);
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 0 then
    raise exception 'another account''s session authorized the caller';
  end if;

  -- A malformed session id is refused.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user, 'session_id', 'not-a-session')::text, true);
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 0 then
    raise exception 'a malformed session id was accepted';
  end if;

  -- A session past `not_after` is refused.
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_user, 'session_id', v_session)::text, true);
  update auth.sessions set not_after = v_now - interval '1 second' where id = v_session;
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 0 then
    raise exception 'a session past not_after was accepted';
  end if;
  update auth.sessions set not_after = v_now + interval '1 hour' where id = v_session;
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 1 then
    raise exception 'a session before not_after was refused';
  end if;

  -- Sign-out deletes the session: the same token stops working at once.
  delete from auth.sessions where id = v_session;
  select count(*) into v_rows from public.get_auth_context();
  if v_rows <> 0 then
    raise exception 'get_auth_context served a signed-out token';
  end if;
  v_message := null;
  begin
    perform private.require_active_user();
  exception when insufficient_privilege then
    v_message := sqlerrm;
  end;
  if v_message is distinct from 'SESSION_REAUTHENTICATION_REQUIRED' then
    raise exception 'require_active_user served a signed-out token: %', v_message;
  end if;

  -- The signed-out token no longer carries the other account's standing
  -- either, but inspecting a different actor is unaffected.
  if not private.actor_has_capability(v_admin, 'user.read') then
    raise exception 'inspecting another actor now depends on the caller''s session';
  end if;

  -- An administrator's own signed-out token loses every capability.
  perform set_config('request.jwt.claim.sub', v_admin::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin, 'session_id', v_admin_session)::text, true);
  if not private.actor_has_capability(v_admin, 'user.read') then
    raise exception 'a live administrator session lost its capability';
  end if;
  delete from auth.sessions where id = v_admin_session;
  if private.actor_has_capability(v_admin, 'user.read') then
    raise exception 'a signed-out administrator token kept its capability';
  end if;

  -- Service-role and scheduled calls carry no subject: the stored actor is
  -- checked as before, although neither account has a session any more.
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  if not private.actor_has_capability(v_admin, 'user.read') then
    raise exception 'service-role capability check now depends on a session';
  end if;
  if (public.consume_business_quota_for_actor(v_user, 'admin.pii.read') ->> 'allowed')::boolean
      is not true then
    raise exception 'service-role business quota refused a sessionless actor';
  end if;

  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '', true);
end;
$test$;

rollback;
