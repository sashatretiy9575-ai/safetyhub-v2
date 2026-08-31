create table private.certificate_export_jobs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  attestation_ids uuid[] not null,
  state text not null default 'ready',
  requested integer not null,
  eligible integer not null,
  skipped integer not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '30 minutes',
  downloaded_at timestamptz,
  constraint certificate_export_jobs_state check (state in ('queued', 'processing', 'ready', 'failed')),
  constraint certificate_export_jobs_size check (
    requested between 1 and 500 and eligible between 0 and requested
      and skipped = requested - eligible
  )
);

create index certificate_export_jobs_actor_created_idx
  on private.certificate_export_jobs (actor_user_id, created_at desc);
create index certificate_export_jobs_expires_idx
  on private.certificate_export_jobs (expires_at);

create function public.create_certificate_export_job(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.export');
  v_ids uuid[];
  v_requested integer;
  v_eligible integer;
  v_job private.certificate_export_jobs%rowtype;
begin
  if not private.actor_has_capability(v_actor_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_REQUIRED';
  end if;
  perform private.enforce_actor_quota('certificate.export');
  select array_agg(id order by id::text), count(*)
  into v_ids, v_requested
  from (select distinct id from unnest(coalesce(p_attestation_ids, '{}'::uuid[])) id) target;
  if v_requested not between 1 and 500
     or v_requested <> coalesce(cardinality(p_attestation_ids), 0) then
    raise exception using errcode = 'program_limit_exceeded', message = 'EXPORT_SELECTION_INVALID';
  end if;
  select count(*) into v_eligible
  from private.admin_attestation_rows row
  where row.attestation_id = any(v_ids)
    and row.certificate_state = 'issued'
    and row.certificate_id is not null;

  insert into private.certificate_export_jobs (
    actor_user_id, attestation_ids, requested, eligible, skipped
  ) values (
    v_actor_id, v_ids, v_requested, v_eligible, v_requested - v_eligible
  ) returning * into v_job;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_actor_id, 'certificate.export_job.created', 'certificate_export', v_job.id::text,
    jsonb_build_object('requested', v_requested, 'eligible', v_eligible), v_job.id
  );

  return jsonb_build_object(
    'id', v_job.id,
    'state', v_job.state,
    'requested', v_job.requested,
    'eligible', v_job.eligible,
    'skipped', v_job.skipped,
    'expiresAt', v_job.expires_at
  );
end;
$$;

create function public.get_certificate_export_job(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.export');
  v_job private.certificate_export_jobs%rowtype;
begin
  select * into v_job
  from private.certificate_export_jobs job
  where job.id = p_job_id and job.actor_user_id = v_actor_id;
  if not found or v_job.expires_at <= statement_timestamp() then
    raise exception using errcode = 'no_data_found', message = 'EXPORT_JOB_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', v_job.id,
    'state', v_job.state,
    'requested', v_job.requested,
    'eligible', v_job.eligible,
    'skipped', v_job.skipped,
    'expiresAt', v_job.expires_at
  );
end;
$$;

create function public.resolve_certificate_export_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.export');
  v_job private.certificate_export_jobs%rowtype;
  v_items jsonb;
  v_skipped jsonb;
begin
  if not private.actor_has_capability(v_actor_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_REQUIRED';
  end if;
  select * into v_job
  from private.certificate_export_jobs job
  where job.id = p_job_id and job.actor_user_id = v_actor_id
  for update;
  if not found or v_job.state <> 'ready' or v_job.expires_at <= statement_timestamp() then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'EXPORT_JOB_NOT_READY';
  end if;

  with requested as (
    select id from unnest(v_job.attestation_ids) id
  ), resolved as (
    select requested.id as requested_attestation_id, row.certificate_state, certificate.*
    from requested
    left join private.admin_attestation_rows row on row.attestation_id = requested.id
    left join public.certificates certificate on certificate.id = row.certificate_id
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', resolved.id,
      'certificateNumber', resolved.certificate_number,
      'userId', resolved.user_id,
      'revisionId', resolved.revision_id,
      'attestationId', resolved.attestation_id,
      'attemptId', resolved.attempt_id,
      'fullName', resolved.full_name,
      'job', resolved.job,
      'organization', resolved.organization,
      'testSlug', resolved.test_slug,
      'testTitle', resolved.test_title,
      'score', resolved.score,
      'total', resolved.total,
      'passScore', resolved.pass_score,
      'bestCompletedAt', resolved.best_completed_at,
      'issuedAt', resolved.issued_at,
      'templateVersion', resolved.template_version,
      'revokedAt', resolved.revoked_at,
      'revokeReason', resolved.revoke_reason
    ) order by resolved.id)
      filter (where resolved.certificate_state = 'issued' and resolved.id is not null), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'attestationId', resolved.requested_attestation_id,
      'reason', coalesce(resolved.certificate_state, 'not_found')
    ) order by resolved.requested_attestation_id)
      filter (where resolved.certificate_state is distinct from 'issued'
        or resolved.id is null), '[]'::jsonb)
  into v_items, v_skipped
  from resolved;

  update private.certificate_export_jobs
  set downloaded_at = statement_timestamp()
  where id = v_job.id;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_actor_id, 'certificate.export_job.downloaded', 'certificate_export', v_job.id::text,
    jsonb_build_object(
      'requested', v_job.requested,
      'eligibleAtCreation', v_job.eligible,
      'exported', jsonb_array_length(v_items),
      'skipped', jsonb_array_length(v_skipped)
    ), v_job.id
  );

  return jsonb_build_object(
    'items', v_items,
    'skipped', v_skipped,
    'requested', v_job.requested,
    'total', v_job.requested,
    'eligible', jsonb_array_length(v_items)
  );
end;
$$;

revoke execute on function public.create_certificate_export_job(uuid[])
  from public, anon, service_role;
revoke execute on function public.get_certificate_export_job(uuid)
  from public, anon, service_role;
revoke execute on function public.resolve_certificate_export_job(uuid)
  from public, anon, service_role;
grant execute on function public.create_certificate_export_job(uuid[]) to authenticated;
grant execute on function public.get_certificate_export_job(uuid) to authenticated;
grant execute on function public.resolve_certificate_export_job(uuid) to authenticated;

create function public.prune_certificate_export_jobs(p_limit integer default 500)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_deleted integer;
begin
  with expired as (
    select id from private.certificate_export_jobs
    where expires_at < statement_timestamp()
    order by expires_at
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
    for update skip locked
  )
  delete from private.certificate_export_jobs job
  using expired where job.id = expired.id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.prune_certificate_export_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.prune_certificate_export_jobs(integer) to service_role;
