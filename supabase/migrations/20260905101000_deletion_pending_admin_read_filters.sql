-- Hide accounts that are being deleted from every operator list.
--
-- Deletion sets `account_controls.deletion_pending` before the account itself
-- disappears. Neither the attestation read model nor the account directory
-- filtered on it, so a person an operator had just deleted came straight back
-- on the next render — the most visible symptom of deletion "not working".
--
-- Written as `not exists` rather than an extra join so neither branch changes
-- its cardinality, and rows whose control record is already gone stay visible.

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
where not exists (
  select 1 from public.account_controls control
  where control.user_id = attestation.user_id and control.deletion_pending
)

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
where certificate.course_deleted_at is not null
  and not exists (
    select 1 from public.account_controls control
    where control.user_id = certificate.user_id and control.deletion_pending
  );

revoke all on private.admin_attestation_rows
  from public, anon, authenticated, service_role;

create or replace function private.list_learning_history_targets_page_provider_internal(
  p_actor_id uuid,
  p_limit integer default 25,
  p_query text default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.delete');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'INVALID_LEARNING_HISTORY_TARGET_CURSOR';
  end if;

  with base_filtered as (
    select auth_user.id,
      coalesce(auth_user.email::text, '') as email,
      coalesce(
        nullif(btrim(concat_ws(' ', profile.name, profile.surname)), ''),
        auth_user.email::text,
        auth_user.id::text
      ) as label,
      role.product_role::text as role,
      control.status::text as status,
      profile.created_at
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.user_roles role on role.user_id = auth_user.id
    join public.account_controls control on control.user_id = auth_user.id
    where auth_user.deleted_at is null
      and role.product_role = 'participant'
      and not control.deletion_pending
      and (v_query is null
        or lower(coalesce(auth_user.email::text, '')) like '%' || v_query || '%'
        or private.normalized_lookup_key(
          concat_ws(' ', profile.name, profile.surname)
        ) like '%' || v_query || '%')
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id)
        < (p_cursor_created_at, p_cursor_id)
  ), ordered as (
    select filtered.*
    from filtered
    order by filtered.created_at desc, filtered.id desc
    limit v_limit + 1
  ), page as (
    select ordered.*
    from ordered
    order by ordered.created_at desc, ordered.id desc
    limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'email', page.email,
      'label', page.label,
      'role', page.role,
      'status', page.status,
      'createdAt', page.created_at
    ) order by page.created_at desc, page.id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object('at', last.created_at, 'id', last.id)
      from page last order by last.created_at, last.id limit 1)
  into v_items, v_total, v_more, v_next
  from page;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total,
    'hasMore', v_more,
    'nextCursor', case when v_more then v_next else null end
  );
end;
$$;

revoke all on function private.list_learning_history_targets_page_provider_internal(
  uuid,integer,text,timestamp with time zone,uuid
) from public, anon, authenticated, service_role;

comment on view private.admin_attestation_rows is
  'Operator read model for attestations; accounts pending deletion are excluded.';
