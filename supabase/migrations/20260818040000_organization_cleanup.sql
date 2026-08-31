alter table private.admin_operation_receipts
  drop constraint admin_operation_receipts_action;
alter table private.admin_operation_receipts
  add constraint admin_operation_receipts_action
  check (action in ('confirm', 'update', 'issue', 'revoke', 'organization.merge'));

create function public.list_organization_cleanup_clusters(p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object(
      'left', jsonb_build_object(
        'id', candidate.left_id,
        'canonicalName', candidate.left_name,
        'participants', candidate.left_participants
      ),
      'right', jsonb_build_object(
        'id', candidate.right_id,
        'canonicalName', candidate.right_name,
        'participants', candidate.right_participants
      ),
      'similarity', candidate.similarity,
      'activeCertificates', candidate.active_certificates
    ) order by candidate.similarity desc, candidate.total_participants desc)
    from (
      with organization_stats as (
        select
          organization.id,
          organization.canonical_name,
          organization.normalized_key,
          count(profile.id) as participants
        from public.organizations organization
        left join public.profiles profile on profile.organization_id = organization.id
        where organization.active
        group by organization.id, organization.canonical_name, organization.normalized_key
      )
      select
        left_org.id as left_id,
        left_org.canonical_name as left_name,
        right_org.id as right_id,
        right_org.canonical_name as right_name,
        extensions.similarity(left_org.normalized_key, right_org.normalized_key) as similarity,
        left_org.participants as left_participants,
        right_org.participants as right_participants,
        (
          select count(*)
          from public.certificates certificate
          join public.profiles profile on profile.id = certificate.user_id
          where profile.organization_id in (left_org.id, right_org.id)
            and certificate.revoked_at is null
        ) as active_certificates,
        left_org.participants + right_org.participants as total_participants
      from organization_stats left_org
      join organization_stats right_org
        on left_org.id < right_org.id
       and extensions.similarity(left_org.normalized_key, right_org.normalized_key) >= 0.55
      where left_org.participants + right_org.participants > 0
      order by similarity desc, total_participants desc
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
    ) candidate
  ), '[]'::jsonb));
end;
$$;

create function public.preview_organization_merge(
  p_source_ids uuid[],
  p_target_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_sources uuid[];
begin
  select array_agg(distinct id order by id) into v_sources
  from unnest(coalesce(p_source_ids, '{}'::uuid[])) id
  where id <> p_target_id;
  if coalesce(cardinality(v_sources), 0) not between 1 and 100
     or not exists (select 1 from public.organizations where id = p_target_id and active)
     or exists (
       select 1 from unnest(v_sources) source_id
       where not exists (
         select 1 from public.organizations where id = source_id and active
       )
     ) then
    raise exception using errcode = 'invalid_parameter_value', message = 'ORGANIZATION_SELECTION_INVALID';
  end if;
  return jsonb_build_object(
    'target', (
      select jsonb_build_object('id', id, 'canonicalName', canonical_name)
      from public.organizations where id = p_target_id
    ),
    'profiles', (
      select count(*) from public.profiles where organization_id = any(v_sources)
    ),
    'verifiedIdentities', (
      select count(*)
      from public.profiles profile
      join public.verified_identities identity on identity.user_id = profile.id
      where profile.organization_id = any(v_sources) and identity.status = 'verified'
    ),
    'activeCertificates', (
      select count(*)
      from public.certificates certificate
      join public.profiles profile on profile.id = certificate.user_id
      where profile.organization_id = any(v_sources) and certificate.revoked_at is null
    )
  );
end;
$$;

create function public.merge_organizations(
  p_idempotency_key uuid,
  p_source_ids uuid[],
  p_target_id uuid,
  p_reissue_certificates boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_sources uuid[];
  v_target public.organizations%rowtype;
  v_user_id uuid;
  v_profiles integer := 0;
  v_reissued_users integer := 0;
  v_active_certificates integer := 0;
  v_request_hash text;
  v_receipt private.admin_operation_receipts%rowtype;
  v_result jsonb;
  v_batch_id uuid := p_idempotency_key;
begin
  if p_idempotency_key is null or char_length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception using errcode = 'invalid_parameter_value', message = 'ORGANIZATION_MERGE_REASON_REQUIRED';
  end if;
  select array_agg(distinct id order by id) into v_sources
  from unnest(coalesce(p_source_ids, '{}'::uuid[])) id where id <> p_target_id;
  if coalesce(cardinality(v_sources), 0) not between 1 and 100 then
    raise exception using errcode = 'invalid_parameter_value', message = 'ORGANIZATION_SELECTION_INVALID';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'sources', to_jsonb(v_sources), 'target', p_target_id,
    'reissue', p_reissue_certificates, 'reason', p_reason
  )::text, 'utf8'), 'sha256'), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(v_actor_id::text || ':' || p_idempotency_key::text, 0));
  select * into v_receipt from private.admin_operation_receipts
  where actor_user_id = v_actor_id and idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  perform private.enforce_actor_quota('admin.attestation.mutate');
  select * into v_target from public.organizations where id = p_target_id and active for update;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ORGANIZATION_STATE_CHANGED';
  end if;
  perform 1 from public.organizations where id = any(v_sources) and active for update;
  if (select count(*) from public.organizations where id = any(v_sources) and active)
      <> cardinality(v_sources) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ORGANIZATION_STATE_CHANGED';
  end if;

  select count(*) into v_active_certificates
  from public.certificates certificate
  join public.profiles profile on profile.id = certificate.user_id
  where profile.organization_id = any(v_sources) and certificate.revoked_at is null;

  for v_user_id in
    select id from public.profiles where organization_id = any(v_sources) order by id
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
    update public.profiles
    set organization_id = v_target.id, organization = v_target.canonical_name
    where id = v_user_id;
    v_profiles := v_profiles + 1;
    if p_reissue_certificates then
      if private.confirm_profile_identity(
        v_user_id, v_actor_id, v_batch_id, 'identity.organization_merge'
      ) then
        v_reissued_users := v_reissued_users + 1;
      end if;
    else
      update public.verified_identities
      set organization = v_target.canonical_name,
          version = version + 1,
          verified_at = statement_timestamp(),
          verified_by = v_actor_id
      where user_id = v_user_id and status = 'verified';
    end if;
  end loop;

  update public.organization_aliases
  set organization_id = v_target.id
  where organization_id = any(v_sources);
  update public.organizations
  set active = false, updated_at = statement_timestamp()
  where id = any(v_sources);

  v_result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'replayed', false,
    'profilesUpdated', v_profiles,
    'activeCertificatesAffected', v_active_certificates,
    'certificatePolicy', case when p_reissue_certificates then 'reissued' else 'preserved' end,
    'identitiesReissued', v_reissued_users,
    'canonicalName', v_target.canonical_name
  );
  insert into private.admin_operation_receipts (
    actor_user_id, idempotency_key, action, request_hash, result
  ) values (v_actor_id, p_idempotency_key, 'organization.merge', v_request_hash, v_result);
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, reason, batch_id
  ) values (
    v_actor_id, 'organization.merged', 'organization', v_target.id::text,
    v_result || jsonb_build_object('sourceIds', to_jsonb(v_sources)), p_reason, v_batch_id
  );
  return v_result;
end;
$$;

revoke execute on function public.list_organization_cleanup_clusters(integer)
  from public, anon, service_role;
revoke execute on function public.preview_organization_merge(uuid[],uuid)
  from public, anon, service_role;
revoke execute on function public.merge_organizations(uuid,uuid[],uuid,boolean,text)
  from public, anon, service_role;
grant execute on function public.list_organization_cleanup_clusters(integer) to authenticated;
grant execute on function public.preview_organization_merge(uuid[],uuid) to authenticated;
grant execute on function public.merge_organizations(uuid,uuid[],uuid,boolean,text) to authenticated;

create or replace function public.get_admin_work_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.read');
begin
  return jsonb_build_object(
    'requiresReview', (
      select count(distinct row.user_id)
      from private.admin_attestation_rows row where row.identity_state <> 'verified'
    ),
    'readyToIssue', (
      select count(*) from private.admin_attestation_rows row
      where row.certificate_state in ('ready', 'revoked')
    ),
    'companyIssues', (
      select count(*)
      from public.organizations left_org
      join public.organizations right_org
        on left_org.id < right_org.id
       and left_org.active and right_org.active
       and extensions.similarity(left_org.normalized_key, right_org.normalized_key) >= 0.55
      where exists (
        select 1 from public.profiles profile
        where profile.organization_id in (left_org.id, right_org.id)
      )
    ),
    'activeCertificates', (
      select count(*) from public.certificates certificate where certificate.revoked_at is null
    ),
    'generatedAt', statement_timestamp()
  );
end;
$$;
