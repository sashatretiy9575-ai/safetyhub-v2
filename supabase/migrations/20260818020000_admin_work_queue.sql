create function public.get_admin_work_queue()
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
      from private.admin_attestation_rows row
      where row.identity_state <> 'verified'
    ),
    'readyToIssue', (
      select count(*)
      from private.admin_attestation_rows row
      where row.certificate_state in ('ready', 'revoked')
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

revoke execute on function public.get_admin_work_queue() from public, anon, service_role;
grant execute on function public.get_admin_work_queue() to authenticated;

create function public.get_admin_attestation_by_certificate_number(p_query text)
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
  join private.admin_attestation_rows row
    on row.user_id = certificate.user_id and row.revision_id = certificate.revision_id
  cross join actor
  where certificate.certificate_number = upper(btrim(coalesce(p_query, '')))
  order by (certificate.revoked_at is null) desc, certificate.issued_at desc
  limit 1
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'attestationId', matched.attestation_id,
      'userId', matched.user_id,
      'bestAttemptId', matched.best_attempt_id,
      'testId', matched.test_id,
      'revisionId', matched.revision_id,
      'testVersion', matched.test_version,
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
      'scoreImproved', matched.score > matched.matched_certificate_score
    )), '[]'::jsonb),
    'total', count(*),
    'hasMore', false,
    'nextCursor', null
  )
  from matched;
$$;

revoke execute on function public.get_admin_attestation_by_certificate_number(text)
  from public, anon, service_role;
grant execute on function public.get_admin_attestation_by_certificate_number(text) to authenticated;
