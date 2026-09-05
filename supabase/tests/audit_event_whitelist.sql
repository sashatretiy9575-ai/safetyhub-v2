begin;

do $test$
declare
  v_old_id bigint;
  v_new_id bigint;
  v_dropped_id bigint;
  v_pruned jsonb;
  v_blocked boolean;
  v_role text;
begin
  -- The whitelist trigger and the immutable trigger must both be present.
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.admin_audit_log'::regclass
      and tgname = 'admin_audit_log_event_whitelist' and not tgisinternal
  ) or not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.admin_audit_log'::regclass
      and tgname = 'admin_audit_log_immutable' and not tgisinternal
  ) then
    raise exception 'audit triggers are missing';
  end if;

  -- Exactly the product-level catalogue is allowed.
  if not (
    private.audit_event_allowed('account.approval.approved')
    and private.audit_event_allowed('test.passed')
    and private.audit_event_allowed('certificate.issued')
    and private.audit_event_allowed('user.self_delete_requested')
    and private.audit_event_allowed('user.purged')
    and private.audit_event_allowed('role.changed')
    and private.audit_event_allowed('role.changed_directly')
    and private.audit_event_allowed('admin.provisioned_by_email')
    and private.audit_event_allowed('superadmin.bootstrapped')
    and private.audit_event_allowed('admin.break_glass_restored')
  ) or private.audit_event_allowed('account.approval.rejected')
    or private.audit_event_allowed('course.published')
    or private.audit_event_allowed('certificate.revoked')
    or private.audit_event_allowed('attestation.bulk.issue')
    or private.audit_event_allowed('user.purge.bulk')
    or private.audit_event_allowed('auth_operation.failed') then
    raise exception 'audit whitelist catalogue drifted';
  end if;

  -- A non-whitelisted insert is silently dropped.
  insert into public.admin_audit_log (action, target_type, target_id)
  values ('course.published', 'test', 'whitelist-probe')
  returning id into v_dropped_id;
  if v_dropped_id is not null or exists (
    select 1 from public.admin_audit_log where target_id = 'whitelist-probe'
  ) then
    raise exception 'non-whitelisted audit insert was not dropped';
  end if;

  -- A whitelisted insert lands.
  insert into public.admin_audit_log (action, target_type, target_id)
  values ('role.changed', 'system', 'whitelist-kept')
  returning id into v_new_id;
  if v_new_id is null then
    raise exception 'whitelisted audit insert was dropped';
  end if;

  -- The new product events are wired into their producers.
  if position('''test.passed''' in pg_get_functiondef(
      'private.complete_test_attempt_unmetered(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'test.passed is not emitted on attempt completion';
  end if;
  if position('user.self_delete_requested' in pg_get_functiondef(
      'public.begin_user_account_purge(uuid)'::regprocedure)) = 0 then
    raise exception 'self-deletion is not audited';
  end if;

  -- Retention: only rows older than 30 days go, and only through the GUC path.
  insert into public.admin_audit_log (action, target_type, target_id, created_at)
  values ('role.changed', 'system', 'whitelist-old',
    statement_timestamp() - interval '31 days')
  returning id into v_old_id;

  v_blocked := false;
  begin
    delete from public.admin_audit_log where id = v_old_id;
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'unauthorized audit delete was accepted';
  end if;

  v_pruned := public.prune_admin_audit_log(100);
  if (v_pruned ->> 'deleted')::integer < 1
    or exists (select 1 from public.admin_audit_log where id = v_old_id)
    or not exists (select 1 from public.admin_audit_log where id = v_new_id) then
    raise exception 'retention pruned the wrong rows: %', v_pruned;
  end if;

  -- The retention GUC alone must not authorize deleting fresh rows.
  v_blocked := false;
  begin
    delete from public.admin_audit_log where id = v_new_id;
  exception when object_not_in_prerequisite_state then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'retention GUC leaked authority over fresh rows';
  end if;

  -- The hourly job exists and only service_role may call the prune function.
  if not exists (
    select 1 from cron.job where jobname = 'safetyhub-audit-retention'
  ) then
    raise exception 'audit retention cron job is missing';
  end if;
  for v_role in select unnest(array['public', 'anon', 'authenticated'])
  loop
    if has_function_privilege(v_role, 'public.prune_admin_audit_log(integer)', 'EXECUTE') then
      raise exception 'prune_admin_audit_log is callable by %', v_role;
    end if;
  end loop;
  if not has_function_privilege(
    'service_role', 'public.prune_admin_audit_log(integer)', 'EXECUTE'
  ) then
    raise exception 'prune_admin_audit_log is not callable by service_role';
  end if;
end;
$test$;

rollback;
