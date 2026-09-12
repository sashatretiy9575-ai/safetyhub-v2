begin;

-- Indexes, batch reads and schedules introduced by
-- 20260912180000_admin_reads_and_schedules.sql.
do $test$
declare
  v_command text;
  v_schedule text;
  v_manifests jsonb;
  v_drafts jsonb;
begin
  -- Indexes exist and are valid.
  perform 1 from pg_catalog.pg_index index_state
  where index_state.indexrelid in (
      'public.article_drafts_updated_idx'::regclass,
      'public.article_drafts_title_trgm_idx'::regclass,
      'public.tests_status_updated_idx'::regclass,
      'public.content_assets_active_created_idx'::regclass,
      'public.certificates_active_idx'::regclass,
      'public.profiles_unlinked_organization_idx'::regclass
    )
    and not (index_state.indisvalid and index_state.indisready);
  if found then
    raise exception 'an admin read index is not valid and ready';
  end if;

  -- The new RPCs are service-role only; the work queue stays callable by
  -- signed-in operators under its capability check.
  if has_function_privilege('anon', 'public.list_admin_article_drafts(text, integer)', 'execute')
    or has_function_privilege('authenticated', 'public.list_admin_article_drafts(text, integer)', 'execute')
    or not has_function_privilege('service_role', 'public.list_admin_article_drafts(text, integer)', 'execute')
    or has_function_privilege('anon', 'public.get_profile_avatar_manifests(uuid[])', 'execute')
    or has_function_privilege('authenticated', 'public.get_profile_avatar_manifests(uuid[])', 'execute')
    or not has_function_privilege('service_role', 'public.get_profile_avatar_manifests(uuid[])', 'execute')
    or has_function_privilege('anon', 'public.configure_storage_reconciler_vault(text, text)', 'execute')
    or has_function_privilege('authenticated', 'public.configure_storage_reconciler_vault(text, text)', 'execute')
    or not has_function_privilege('service_role', 'public.configure_storage_reconciler_vault(text, text)', 'execute')
    or has_function_privilege('anon', 'public.get_admin_work_queue()', 'execute')
    or not has_function_privilege('authenticated', 'public.get_admin_work_queue()', 'execute')
    or not has_function_privilege('service_role', 'public.get_admin_work_queue()', 'execute') then
    raise exception 'admin read grants are unsafe';
  end if;

  -- A signed-in operator cannot call the service-role reads at all.
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  perform set_config('role', 'authenticated', true);
  begin
    perform public.list_admin_article_drafts(null, 10);
    raise exception 'article draft list is callable by authenticated callers';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform public.get_profile_avatar_manifests(array['00000000-0000-4000-8000-000000000001'::uuid]);
    raise exception 'avatar manifests are callable by authenticated callers';
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  -- Service role: the shapes are arrays of objects with the documented keys.
  select public.list_admin_article_drafts('охрана', 5) into v_drafts;
  if jsonb_typeof(v_drafts) <> 'array' then
    raise exception 'article draft list must be a JSON array';
  end if;
  if jsonb_array_length(v_drafts) > 0
    and not (v_drafts -> 0 ?& array['id', 'slug', 'title', 'status', 'isPublished', 'updatedAt', 'hasDraftChanges']) then
    raise exception 'article draft rows carry the wrong keys';
  end if;
  select public.get_profile_avatar_manifests(array[]::uuid[]) into v_manifests;
  if v_manifests <> '[]'::jsonb then
    raise exception 'empty batch must return an empty array';
  end if;

  -- The sweep runs every five minutes and skips idle ticks; the reconcile is daily.
  select job.schedule, job.command into v_schedule, v_command
  from cron.job job
  where job.jobname = 'safetyhub-notification-dispatch';
  if v_schedule is distinct from '*/5 * * * *' then
    raise exception 'notification sweep schedule is %, expected */5 * * * *', v_schedule;
  end if;
  if v_command !~ 'exists' or v_command !~ 'lease_expires_at' or v_command !~ 'telegram_delivery' then
    raise exception 'notification sweep command lacks the idle guard or the feature gate';
  end if;
  select job.schedule into v_schedule
  from cron.job job
  where job.jobname = 'safetyhub-storage-reconcile';
  if v_schedule is distinct from '25 3 * * *' then
    raise exception 'storage reconcile schedule is %, expected 25 3 * * *', v_schedule;
  end if;

  -- Unconfigured Vault makes the reconcile request a silent no-op.
  if private.request_storage_reconcile() is not null then
    raise exception 'storage reconcile must be dormant without Vault configuration';
  end if;
end;
$test$;

rollback;
