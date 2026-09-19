-- Refresh a fixed selection after a single-person mutation. Re-running its old
-- filter could remove the changed row or select new people without consent.
create function public.refresh_admin_attestation_selection(p_record_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.require_capability('results.read');
  if p_record_ids is null or cardinality(p_record_ids) < 1
    or cardinality(p_record_ids) > 500
    or array_position(p_record_ids, null) is not null then
    raise exception using errcode = '22023', message = 'INVALID_ATTESTATION_SELECTION';
  end if;
  with selected as (
    select row.* from private.admin_attestation_rows row
    where row.attestation_id = any(p_record_ids)
  )
  select jsonb_build_object(
    'recordIds', coalesce(jsonb_agg(attestation_id order by attestation_id), '[]'::jsonb),
    'attestationIds', coalesce(jsonb_agg(attestation_id order by attestation_id)
      filter (where test_id is not null), '[]'::jsonb),
    'userIds', coalesce(jsonb_agg(distinct user_id)
      filter (where test_id is not null), '[]'::jsonb),
    'certificateIds', coalesce(jsonb_agg(distinct certificate_id)
      filter (where certificate_id is not null and certificate_state = 'issued'), '[]'::jsonb),
    'total', count(*),
    'uniquePeople', count(distinct user_id) filter (where test_id is not null),
    'pendingIdentity', count(*) filter (
      where test_id is not null and certificate_state = 'pending_identity'
    ),
    'ready', count(*) filter (
      where test_id is not null and (certificate_state in ('ready', 'revoked')
        or (certificate_state = 'issued' and identity_state = 'verified' and score_improved))
    ),
    'issued', count(*) filter (where certificate_state = 'issued'),
    'exportable', count(*) filter (where certificate_state = 'issued')
  ) into v_result from selected;
  return v_result;
end;
$$;
revoke all on function public.refresh_admin_attestation_selection(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.refresh_admin_attestation_selection(uuid[]) to authenticated;
