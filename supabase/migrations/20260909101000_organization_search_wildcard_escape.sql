-- `%` and `_` are wildcards for LIKE, and `private.normalize_organization_key`
-- strips punctuation but leaves them intact. A query of `%%` therefore matched
-- the entire organization directory: an authenticated participant could read
-- every registered company name a page at a time (B1-37).
--
-- The escaping lives here rather than in the normalizer, which is IMMUTABLE and
-- backs the unique index on `organizations.normalized_key`; changing it would
-- invalidate stored keys.
create or replace function public.search_profile_organizations(p_query text, p_limit integer default 8)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_query text := private.normalize_organization_key(p_query);
  v_pattern text := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(v_query, '\', '\\'),
      '%', '\%'
    ),
    '_', '\_'
  );
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  return coalesce((
    select array_agg(candidate.canonical_name order by candidate.rank, candidate.canonical_name)
    from (
      select distinct organization.canonical_name,
        case
          when organization.normalized_key = v_query then 0
          when organization.normalized_key like v_pattern || '%' escape '\' then 1
          else 2
        end as rank
      from public.organizations organization
      left join public.organization_aliases alias on alias.organization_id = organization.id
      where organization.active
        and (
          v_query = ''
          or organization.normalized_key like '%' || v_pattern || '%' escape '\'
          or alias.normalized_key like '%' || v_pattern || '%' escape '\'
        )
      order by rank, organization.canonical_name
      limit v_limit
    ) candidate
  ), '{}'::text[]);
end;
$$;

revoke all on function public.search_profile_organizations(text, integer)
  from public, anon, service_role;
grant execute on function public.search_profile_organizations(text, integer) to authenticated;
