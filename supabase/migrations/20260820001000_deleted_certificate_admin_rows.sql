-- Keep certificates for deleted courses visible in the existing result ledger.
-- The certificate id is used as the internal cursor key for historical rows;
-- the application exposes nullable attestation/revision/attempt links.

create or replace view private.admin_attestation_rows as
select
  attestation.id as attestation_id,
  attestation.user_id,
  attestation.best_attempt_id,
  revision.test_id,
  revision.id as revision_id,
  revision.version as test_version,
  profile.name,
  profile.surname,
  concat_ws(' ', profile.name, profile.surname) as full_name,
  profile.job,
  profile.organization,
  private.normalized_lookup_key(profile.organization) as organization_key,
  profile.avatar_updated_at is not null as avatar_available,
  revision.title as course_title,
  attestation.best_score as score,
  revision.question_count as total,
  revision.pass_score,
  attestation.best_completed_at as completed_at,
  identity_context.state as identity_state,
  case
    when attestation.best_score < revision.pass_score then 'not_eligible'
    when identity_context.state <> 'verified' then 'pending_identity'
    when latest_certificate.id is null then 'ready'
    when latest_certificate.revoked_at is null then 'issued'
    else 'revoked'
  end as certificate_state,
  latest_certificate.id as certificate_id,
  latest_certificate.score as certificate_score,
  latest_certificate.certificate_number,
  latest_certificate.revoked_at,
  latest_certificate.issued_at,
  latest_certificate.id is not null
    and attestation.best_score > latest_certificate.score as score_improved
from public.attestations attestation
join public.test_revisions revision on revision.id = attestation.revision_id
join public.profiles profile on profile.id = attestation.user_id
join public.verified_identities identity on identity.user_id = attestation.user_id
cross join lateral (
  select case
    when identity.status = 'revoked' then 'revoked'
    when identity.status <> 'verified' then 'pending'
    when (identity.name, identity.surname, identity.job, identity.organization)
      is distinct from (profile.name, profile.surname, profile.job, profile.organization)
      then 'changed'
    else 'verified'
  end as state
) identity_context
left join (
  select distinct on (certificate.user_id, certificate.revision_id)
    certificate.*
  from public.certificates certificate
  where certificate.course_deleted_at is null
  order by
    certificate.user_id,
    certificate.revision_id,
    (certificate.revoked_at is null) desc,
    certificate.issued_at desc,
    certificate.id desc
) latest_certificate
  on latest_certificate.user_id = attestation.user_id
  and latest_certificate.revision_id = attestation.revision_id

union all

select
  certificate.id as attestation_id,
  certificate.user_id,
  null::uuid as best_attempt_id,
  null::uuid as test_id,
  null::uuid as revision_id,
  0::integer as test_version,
  coalesce(nullif(profile.name, ''), split_part(certificate.full_name, ' ', 1)) as name,
  coalesce(
    nullif(profile.surname, ''),
    nullif(btrim(substr(certificate.full_name, char_length(split_part(certificate.full_name, ' ', 1)) + 1)), '')
  ) as surname,
  certificate.full_name,
  certificate.job,
  certificate.organization,
  private.normalized_lookup_key(certificate.organization) as organization_key,
  coalesce(profile.avatar_updated_at is not null, false) as avatar_available,
  certificate.test_title as course_title,
  certificate.score,
  certificate.total,
  certificate.pass_score,
  certificate.best_completed_at as completed_at,
  'verified'::text as identity_state,
  case when certificate.revoked_at is null then 'issued' else 'revoked' end as certificate_state,
  certificate.id as certificate_id,
  certificate.score as certificate_score,
  certificate.certificate_number,
  certificate.revoked_at,
  certificate.issued_at,
  false as score_improved
from public.certificates certificate
left join public.profiles profile on profile.id = certificate.user_id
where certificate.course_deleted_at is not null;

create or replace function public.list_admin_attestations_page(
  p_limit integer default 50,
  p_query text default null,
  p_organization text default null,
  p_test_id uuid default null,
  p_result_state text default null,
  p_certificate_state text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_sort text default 'completed_desc',
  p_cursor jsonb default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := private.require_capability('results.read');
  v_limit integer := case when p_limit in (25, 50, 100) then p_limit else 50 end;
  v_sort text := coalesce(p_sort, 'completed_desc');
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_organization text := nullif(private.normalized_lookup_key(p_organization), '');
  v_items jsonb;
  v_total integer;
  v_has_more boolean;
  v_next jsonb;
  v_cursor_id uuid;
  v_cursor_values jsonb;
  v_cursor_first text;
  v_cursor_second text;
  v_cursor_third text;
  v_cursor_time timestamptz;
  v_cursor_score integer;
begin
  if v_sort not in (
    'name_asc', 'organization_asc', 'completed_desc', 'completed_asc', 'score_desc', 'score_asc'
  ) then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTESTATION_SORT';
  end if;
  if p_cursor is not null then
    if jsonb_typeof(p_cursor -> 'values') is distinct from 'array'
      or jsonb_array_length(p_cursor -> 'values') <> (case
        when v_sort = 'name_asc' then 2
        when v_sort = 'organization_asc' then 3
        else 1 end)
      or nullif(p_cursor ->> 'id', '') is null then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ATTESTATION_CURSOR';
    end if;
    begin
      v_cursor_id := (p_cursor ->> 'id')::uuid;
    exception when invalid_text_representation then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ATTESTATION_CURSOR';
    end;
    v_cursor_values := p_cursor -> 'values';
    v_cursor_first := v_cursor_values ->> 0;
    v_cursor_second := v_cursor_values ->> 1;
    v_cursor_third := v_cursor_values ->> 2;
    if v_cursor_first is null
      or (v_sort in ('name_asc', 'organization_asc') and v_cursor_second is null)
      or (v_sort = 'organization_asc' and v_cursor_third is null) then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ATTESTATION_CURSOR';
    end if;
    begin
      if v_sort in ('completed_desc', 'completed_asc') then
        v_cursor_time := v_cursor_first::timestamptz;
      elsif v_sort in ('score_desc', 'score_asc') then
        v_cursor_score := v_cursor_first::integer;
      end if;
    exception when invalid_text_representation or datetime_field_overflow
      or numeric_value_out_of_range then
      raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ATTESTATION_CURSOR';
    end;
  end if;

  with base_filtered as (
    select row.*,
      count(*) over (partition by row.organization_key)::integer as organization_group_count
    from private.admin_attestation_rows row
    where (v_query is null
        or private.normalized_lookup_key(row.full_name) like '%' || v_query || '%'
        or row.organization_key like '%' || v_query || '%'
        or private.normalized_lookup_key(row.course_title) like '%' || v_query || '%'
        or private.normalized_lookup_key(row.certificate_number) like '%' || v_query || '%')
      and (v_organization is null or row.organization_key = v_organization)
      and (p_test_id is null or row.test_id = p_test_id)
      and (p_result_state is null
        or (p_result_state = 'passed' and row.score >= row.pass_score)
        or (p_result_state = 'failed' and row.score < row.pass_score))
      and (p_certificate_state is null or row.certificate_state = p_certificate_state)
      and (p_from is null or row.completed_at >= p_from)
      and (p_to is null or row.completed_at < p_to)
  ), filtered as (
    select row.*
    from base_filtered row
    where p_cursor is null or (
      (v_sort = 'name_asc' and (
        lower(row.surname) > v_cursor_first
        or (lower(row.surname) = v_cursor_first and lower(row.name) > v_cursor_second)
        or (lower(row.surname) = v_cursor_first and lower(row.name) = v_cursor_second
          and row.attestation_id < v_cursor_id)
      ))
      or (v_sort = 'organization_asc' and (
        row.organization_key > v_cursor_first
        or (row.organization_key = v_cursor_first and lower(row.surname) > v_cursor_second)
        or (row.organization_key = v_cursor_first and lower(row.surname) = v_cursor_second
          and lower(row.name) > v_cursor_third)
        or (row.organization_key = v_cursor_first and lower(row.surname) = v_cursor_second
          and lower(row.name) = v_cursor_third and row.attestation_id < v_cursor_id)
      ))
      or (v_sort = 'completed_asc' and (
        row.completed_at > v_cursor_time
        or (row.completed_at = v_cursor_time and row.attestation_id < v_cursor_id)
      ))
      or (v_sort = 'completed_desc' and (
        row.completed_at < v_cursor_time
        or (row.completed_at = v_cursor_time and row.attestation_id < v_cursor_id)
      ))
      or (v_sort = 'score_asc' and (
        row.score > v_cursor_score
        or (row.score = v_cursor_score and row.attestation_id < v_cursor_id)
      ))
      or (v_sort = 'score_desc' and (
        row.score < v_cursor_score
        or (row.score = v_cursor_score and row.attestation_id < v_cursor_id)
      ))
    )
  ), ordered as (
    select * from filtered
    order by
      case when v_sort = 'name_asc' then lower(surname) end asc,
      case when v_sort = 'name_asc' then lower(name) end asc,
      case when v_sort = 'organization_asc' then organization_key end asc,
      case when v_sort = 'organization_asc' then lower(surname) end asc,
      case when v_sort = 'organization_asc' then lower(name) end asc,
      case when v_sort = 'completed_asc' then completed_at end asc,
      case when v_sort = 'score_asc' then score end asc,
      case when v_sort = 'score_desc' then score end desc,
      case when v_sort = 'completed_desc' then completed_at end desc,
      attestation_id desc
    limit v_limit + 1
  ), page as (
    select * from ordered limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'recordId', page.attestation_id,
      'kind', case when page.test_id is null
        then 'deleted-course-certificate' else 'attestation' end,
      'attestationId', case when page.test_id is null then null else page.attestation_id end,
      'userId', page.user_id,
      'bestAttemptId', page.best_attempt_id,
      'testId', page.test_id,
      'revisionId', page.revision_id,
      'testVersion', case when page.test_id is null then null else page.test_version end,
      'name', page.name,
      'surname', page.surname,
      'fullName', page.full_name,
      'job', page.job,
      'organization', page.organization,
      'organizationGroupCount', page.organization_group_count,
      'avatarAvailable', page.avatar_available,
      'avatarUrl', null,
      'courseTitle', page.course_title,
      'score', page.score,
      'total', page.total,
      'passScore', page.pass_score,
      'completedAt', page.completed_at,
      'identityState', page.identity_state,
      'certificateState', page.certificate_state,
      'certificateId', page.certificate_id,
      'certificateScore', page.certificate_score,
      'certificateNumber', page.certificate_number,
      'scoreImproved', page.score_improved,
      'courseDeleted', page.test_id is null
    ) order by
      case when v_sort = 'name_asc' then lower(page.surname) end asc,
      case when v_sort = 'name_asc' then lower(page.name) end asc,
      case when v_sort = 'organization_asc' then page.organization_key end asc,
      case when v_sort = 'organization_asc' then lower(page.surname) end asc,
      case when v_sort = 'organization_asc' then lower(page.name) end asc,
      case when v_sort = 'completed_asc' then page.completed_at end asc,
      case when v_sort = 'score_asc' then page.score end asc,
      case when v_sort = 'score_desc' then page.score end desc,
      case when v_sort = 'completed_desc' then page.completed_at end desc,
      page.attestation_id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object(
      'values', case
        when v_sort = 'name_asc' then
          jsonb_build_array(lower(last.surname), lower(last.name))
        when v_sort = 'organization_asc' then
          jsonb_build_array(last.organization_key, lower(last.surname), lower(last.name))
        when v_sort in ('completed_desc', 'completed_asc') then
          jsonb_build_array(last.completed_at::text)
        else jsonb_build_array(last.score)
      end,
      'id', last.attestation_id
    ) from (
      select * from page order by
        case when v_sort = 'name_asc' then lower(surname) end desc,
        case when v_sort = 'name_asc' then lower(name) end desc,
        case when v_sort = 'organization_asc' then organization_key end desc,
        case when v_sort = 'organization_asc' then lower(surname) end desc,
        case when v_sort = 'organization_asc' then lower(name) end desc,
        case when v_sort = 'completed_asc' then completed_at end desc,
        case when v_sort = 'score_asc' then score end desc,
        case when v_sort = 'score_desc' then score end asc,
        case when v_sort = 'completed_desc' then completed_at end asc,
        attestation_id asc
      limit 1
    ) last)
  into v_items, v_total, v_has_more, v_next
  from page;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_has_more,
    'nextCursor', case when v_has_more then v_next else null end
  );
end;
$$;

create or replace function public.get_admin_attestation_filters()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    perform private.require_capability('results.read');
  end if;
  return jsonb_build_object(
    'organizations', coalesce((
      select jsonb_agg(item.organization order by item.organization)
      from (
        select min(row.organization) as organization
        from private.admin_attestation_rows row
        where nullif(row.organization_key, '') is not null
        group by row.organization_key
      ) item
    ), '[]'::jsonb),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object('id', item.test_id, 'title', item.title)
        order by item.title, item.test_id)
      from (
        select row.test_id, min(row.course_title) as title
        from private.admin_attestation_rows row
        where row.test_id is not null
        group by row.test_id
      ) item
    ), '[]'::jsonb)
  );
end;
$$;

-- A retained certificate is a first-class ledger row, but it must never be
-- fed back into identity confirmation or certificate issuance. recordIds are
-- for selecting/exporting rows; attestationIds contain only live attestations.
create or replace function public.resolve_admin_attestation_selection(
  p_query text default null,
  p_organization text default null,
  p_test_id uuid default null,
  p_result_state text default null,
  p_certificate_state text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_sort text default 'completed_desc'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_organization text := nullif(private.normalized_lookup_key(p_organization), '');
  v_count integer;
  v_result jsonb;
begin
  perform private.require_capability('results.read');
  with filtered as (
    select row.* from private.admin_attestation_rows row
    where (v_query is null
        or private.normalized_lookup_key(row.full_name) like '%' || v_query || '%'
        or row.organization_key like '%' || v_query || '%'
        or private.normalized_lookup_key(row.course_title) like '%' || v_query || '%'
        or private.normalized_lookup_key(row.certificate_number) = v_query)
      and (v_organization is null or row.organization_key = v_organization)
      and (p_test_id is null or row.test_id = p_test_id)
      and (p_result_state is null
        or (p_result_state = 'passed' and row.score >= row.pass_score)
        or (p_result_state = 'failed' and row.score < row.pass_score))
      and (p_certificate_state is null or row.certificate_state = p_certificate_state)
      and (p_from is null or row.completed_at >= p_from)
      and (p_to is null or row.completed_at < p_to)
  )
  select count(*)::integer into v_count from filtered;
  if v_count > 500 then
    raise exception using errcode = 'program_limit_exceeded', message = 'ATTESTATION_SELECTION_TOO_LARGE';
  end if;

  with filtered as (
    select row.* from private.admin_attestation_rows row
    where (v_query is null
        or private.normalized_lookup_key(row.full_name) like '%' || v_query || '%'
        or row.organization_key like '%' || v_query || '%'
        or private.normalized_lookup_key(row.course_title) like '%' || v_query || '%'
        or private.normalized_lookup_key(row.certificate_number) = v_query)
      and (v_organization is null or row.organization_key = v_organization)
      and (p_test_id is null or row.test_id = p_test_id)
      and (p_result_state is null
        or (p_result_state = 'passed' and row.score >= row.pass_score)
        or (p_result_state = 'failed' and row.score < row.pass_score))
      and (p_certificate_state is null or row.certificate_state = p_certificate_state)
      and (p_from is null or row.completed_at >= p_from)
      and (p_to is null or row.completed_at < p_to)
  )
  select jsonb_build_object(
    'recordIds', coalesce(jsonb_agg(attestation_id order by attestation_id), '[]'::jsonb),
    'attestationIds', coalesce(jsonb_agg(attestation_id order by attestation_id)
      filter (where test_id is not null), '[]'::jsonb),
    'userIds', coalesce(jsonb_agg(distinct user_id)
      filter (where test_id is not null), '[]'::jsonb),
    'certificateIds', coalesce(jsonb_agg(distinct certificate_id)
      filter (where certificate_id is not null and certificate_state = 'issued'), '[]'::jsonb),
    'total', v_count,
    'uniquePeople', count(distinct user_id) filter (where test_id is not null),
    'pendingIdentity', count(*) filter (
      where test_id is not null and certificate_state = 'pending_identity'
    ),
    'ready', count(*) filter (
      where test_id is not null and certificate_state in ('ready', 'revoked')
    ),
    'issued', count(*) filter (where certificate_state = 'issued'),
    'exportable', count(*) filter (where certificate_state = 'issued')
  ) into v_result from filtered;
  return v_result;
end;
$$;

-- Certificate-number lookup must also find historical rows whose revision link
-- was intentionally detached during course deletion.
create or replace function public.get_admin_attestation_by_certificate_number(p_query text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with actor as (
    select private.require_capability('results.read') as id
  ), matched as (
    select row.*,
      certificate.id as matched_certificate_id,
      certificate.score as matched_certificate_score,
      certificate.certificate_number as matched_certificate_number,
      certificate.revoked_at as matched_certificate_revoked_at,
      (select count(*)::integer from private.admin_attestation_rows peer
        where peer.organization_key = row.organization_key) as organization_group_count
    from public.certificates certificate
    join private.admin_attestation_rows row on (
      (certificate.course_deleted_at is not null and row.attestation_id = certificate.id)
      or (
        certificate.course_deleted_at is null
        and row.user_id = certificate.user_id
        and row.revision_id = certificate.revision_id
      )
    )
    cross join actor
    where certificate.certificate_number = upper(btrim(coalesce(p_query, '')))
    order by (certificate.revoked_at is null) desc, certificate.issued_at desc
    limit 1
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'recordId', matched.attestation_id,
      'kind', case when matched.test_id is null
        then 'deleted-course-certificate' else 'attestation' end,
      'attestationId', case when matched.test_id is null then null else matched.attestation_id end,
      'userId', matched.user_id,
      'bestAttemptId', matched.best_attempt_id,
      'testId', matched.test_id,
      'revisionId', matched.revision_id,
      'testVersion', case when matched.test_id is null then null else matched.test_version end,
      'name', matched.name,
      'surname', matched.surname,
      'fullName', matched.full_name,
      'job', matched.job,
      'organization', matched.organization,
      'organizationGroupCount', matched.organization_group_count,
      'avatarAvailable', matched.avatar_available,
      'avatarUrl', null,
      'courseTitle', matched.course_title,
      'score', matched.score,
      'total', matched.total,
      'passScore', matched.pass_score,
      'completedAt', matched.completed_at,
      'identityState', matched.identity_state,
      'certificateState', case
        when matched.matched_certificate_revoked_at is null then 'issued'
        else 'revoked'
      end,
      'certificateId', matched.matched_certificate_id,
      'certificateScore', matched.matched_certificate_score,
      'certificateNumber', matched.matched_certificate_number,
      'scoreImproved', matched.score > matched.matched_certificate_score,
      'courseDeleted', matched.test_id is null
    )), '[]'::jsonb),
    'total', count(*),
    'hasMore', false,
    'nextCursor', null
  )
  from matched;
$$;

create or replace function public.get_admin_work_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.require_capability('results.read');
  return jsonb_build_object(
    'pendingIdentity', (
      select count(distinct row.user_id)
      from private.admin_attestation_rows row
      where row.test_id is not null and row.identity_state <> 'verified'
    ),
    'readyToIssue', (
      select count(*)
      from private.admin_attestation_rows row
      where row.test_id is not null and row.certificate_state in ('ready', 'revoked')
    ),
    'companyIssues', (
      select count(*)
      from public.profiles profile
      where profile.organization <> '' and profile.organization_id is null
    ),
    'activeCertificates', (
      select count(*) from public.certificates certificate where certificate.revoked_at is null
    ),
    'generatedAt', statement_timestamp()
  );
end;
$$;

-- Identity corrections may reissue certificates for live attestations only.
-- A certificate retained after course deletion is an immutable historical
-- snapshot and must remain byte-for-byte stable.
create or replace function private.confirm_profile_identity(
  p_user_id uuid,
  p_actor_id uuid,
  p_batch_id uuid,
  p_action text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_identity public.verified_identities%rowtype;
  v_before_identity public.verified_identities%rowtype;
  v_changed boolean;
  v_certificate public.certificates%rowtype;
  v_attestation_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if not exists (
    select 1 from public.account_controls control
    where control.user_id = p_user_id
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;
  select * into v_profile from public.profiles where id = p_user_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if char_length(v_profile.name) = 0 or char_length(v_profile.surname) = 0
    or char_length(v_profile.job) = 0 or char_length(v_profile.organization) = 0
    or v_profile.avatar_updated_at is null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'PROFILE_INCOMPLETE';
  end if;
  select * into v_identity
  from public.verified_identities where user_id = p_user_id for update;
  v_before_identity := v_identity;
  v_changed := v_identity.status <> 'verified'
    or (v_identity.name, v_identity.surname, v_identity.job, v_identity.organization)
      is distinct from (v_profile.name, v_profile.surname, v_profile.job, v_profile.organization);
  if not v_changed then
    return false;
  end if;
  update public.verified_identities
  set status = 'verified',
      version = greatest(version + 1, 1),
      name = v_profile.name,
      surname = v_profile.surname,
      job = v_profile.job,
      organization = v_profile.organization,
      verified_at = statement_timestamp(),
      verified_by = p_actor_id,
      revoked_at = null,
      revoked_by = null,
      revoke_reason = null
  where user_id = p_user_id
  returning * into v_identity;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, batch_id
  ) values (
    p_actor_id, p_user_id, p_action, 'identity', p_user_id::text,
    jsonb_build_object(
      'status', v_before_identity.status,
      'version', v_before_identity.version,
      'name', v_before_identity.name,
      'surname', v_before_identity.surname,
      'job', v_before_identity.job,
      'organization', v_before_identity.organization
    ),
    jsonb_build_object(
      'status', 'verified',
      'version', v_identity.version,
      'name', v_identity.name,
      'surname', v_identity.surname,
      'job', v_identity.job,
      'organization', v_identity.organization
    ),
    p_batch_id
  );
  for v_certificate in
    select document.*
    from public.certificates document
    where document.user_id = p_user_id
      and document.revoked_at is null
      and document.course_deleted_at is null
    order by document.revision_id, document.id
    for update
  loop
    update public.certificates
    set revoked_at = statement_timestamp(),
        revoked_by = p_actor_id,
        revoke_reason = 'Сертификационные данные исправлены'
    where id = v_certificate.id;
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      after_data, reason, batch_id
    ) values (
      p_actor_id, p_user_id, 'certificate.revoked', 'certificate', v_certificate.id::text,
      jsonb_build_object('certificateNumber', v_certificate.certificate_number),
      'Сертификационные данные исправлены', p_batch_id
    );
    select id into v_attestation_id
    from public.attestations
    where user_id = p_user_id and revision_id = v_certificate.revision_id;
    perform private.issue_certificate_for_attestation(
      v_attestation_id, p_actor_id, 'identity_correction', v_certificate.id, p_batch_id
    );
  end loop;
  return true;
end;
$$;
