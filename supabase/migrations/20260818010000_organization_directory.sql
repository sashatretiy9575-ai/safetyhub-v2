-- Canonical organization directory. Profiles keep the text column during the
-- rolling migration, but organization_id is authoritative and certificate text
-- remains an immutable issuance-time snapshot.

create function private.normalize_organization_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select regexp_replace(
    regexp_replace(
      lower(btrim(coalesce(p_value, ''))),
      '[«»"''`.,()\[\]{}]+',
      ' ',
      'g'
    ),
    '[[:space:]]+',
    ' ',
    'g'
  );
$$;

revoke execute on function private.normalize_organization_key(text)
  from public, anon, authenticated, service_role;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  normalized_key text not null,
  active boolean not null default true,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint organizations_canonical_name_length
    check (char_length(canonical_name) between 1 and 200),
  constraint organizations_normalized_key_length
    check (char_length(normalized_key) between 1 and 200),
  constraint organizations_normalized_key_unique unique (normalized_key)
);

create table public.organization_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  alias text not null,
  normalized_key text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint organization_aliases_alias_length check (char_length(alias) between 1 and 200),
  constraint organization_aliases_key_length check (char_length(normalized_key) between 1 and 200),
  constraint organization_aliases_key_unique unique (normalized_key)
);

create index organization_aliases_organization_idx
  on public.organization_aliases (organization_id);
create index organizations_active_name_idx
  on public.organizations (active, canonical_name);

-- Choose the most frequently used spelling as the initial canonical name.
with variants as (
  select
    private.normalize_organization_key(profile.organization) as normalized_key,
    btrim(profile.organization) as variant,
    count(*) as use_count
  from public.profiles profile
  where private.normalize_organization_key(profile.organization) <> ''
  group by 1, 2
), ranked as (
  select
    variants.*,
    row_number() over (
      partition by variants.normalized_key
      order by variants.use_count desc, char_length(variants.variant) desc, variants.variant
    ) as position
  from variants
)
insert into public.organizations (canonical_name, normalized_key)
select ranked.variant, ranked.normalized_key
from ranked
where ranked.position = 1;

insert into public.organization_aliases (organization_id, alias, normalized_key)
select organization.id, organization.canonical_name, organization.normalized_key
from public.organizations organization;

alter table public.profiles
  add column organization_id uuid references public.organizations(id) on delete restrict;

update public.profiles profile
set
  organization_id = organization.id,
  organization = organization.canonical_name
from public.organizations organization
where organization.normalized_key = private.normalize_organization_key(profile.organization);

create index profiles_organization_id_idx on public.profiles (organization_id);

create function private.resolve_profile_organization(p_value text)
returns public.organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := private.normalize_profile_text(p_value);
  v_key text := private.normalize_organization_key(p_value);
  v_organization public.organizations%rowtype;
begin
  if v_key = '' or char_length(v_name) not between 1 and 200 then
    raise exception using errcode = 'check_violation', message = 'ORGANIZATION_REQUIRED';
  end if;

  select organization.* into v_organization
  from public.organization_aliases alias
  join public.organizations organization on organization.id = alias.organization_id
  where alias.normalized_key = v_key and organization.active
  limit 1;

  if found then return v_organization; end if;

  insert into public.organizations (canonical_name, normalized_key)
  values (v_name, v_key)
  on conflict (normalized_key) do update
    set normalized_key = excluded.normalized_key
  returning * into v_organization;

  insert into public.organization_aliases (organization_id, alias, normalized_key)
  values (v_organization.id, v_organization.canonical_name, v_organization.normalized_key)
  on conflict (normalized_key) do nothing;

  return v_organization;
end;
$$;

revoke execute on function private.resolve_profile_organization(text)
  from public, anon, authenticated, service_role;

create function private.attach_profile_organization()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization public.organizations%rowtype;
begin
  if private.normalize_organization_key(new.organization) = '' and new.organization_id is null then
    new.organization := '';
    return new;
  end if;
  if new.organization_id is not null
     and (tg_op = 'INSERT' or new.organization_id is distinct from old.organization_id) then
    select * into v_organization
    from public.organizations
    where id = new.organization_id and active;
    if not found then
      raise exception using errcode = 'foreign_key_violation', message = 'ORGANIZATION_NOT_FOUND';
    end if;
  else
    v_organization := private.resolve_profile_organization(new.organization);
  end if;
  new.organization_id := v_organization.id;
  new.organization := v_organization.canonical_name;
  return new;
end;
$$;

create trigger profiles_attach_organization
before insert or update of organization, organization_id on public.profiles
for each row execute function private.attach_profile_organization();

revoke execute on function private.attach_profile_organization()
  from public, anon, authenticated, service_role;

-- Replace profile organization autocomplete with the canonical directory.
create or replace function public.search_profile_organizations(
  p_query text,
  p_limit integer default 8
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_query text := private.normalize_organization_key(p_query);
  v_limit integer := least(greatest(coalesce(p_limit, 8), 1), 20);
begin
  return coalesce((
    select array_agg(candidate.canonical_name order by candidate.rank, candidate.canonical_name)
    from (
      select distinct organization.canonical_name,
        case
          when organization.normalized_key = v_query then 0
          when organization.normalized_key like v_query || '%' then 1
          else 2
        end as rank
      from public.organizations organization
      left join public.organization_aliases alias on alias.organization_id = organization.id
      where organization.active
        and (
          v_query = ''
          or organization.normalized_key like '%' || v_query || '%'
          or alias.normalized_key like '%' || v_query || '%'
        )
      order by rank, organization.canonical_name
      limit v_limit
    ) candidate
  ), '{}'::text[]);
end;
$$;

alter table public.organizations enable row level security;
alter table public.organization_aliases enable row level security;

create policy organizations_admin_read on public.organizations
for select to authenticated
using (private.actor_has_capability((select auth.uid()), 'identity.read'));

create policy organization_aliases_admin_read on public.organization_aliases
for select to authenticated
using (private.actor_has_capability((select auth.uid()), 'identity.read'));

revoke all on public.organizations, public.organization_aliases
  from public, anon, authenticated;
grant select on public.organizations, public.organization_aliases to authenticated;

comment on table public.organizations is
  'Canonical organization directory referenced by participant profiles.';
comment on table public.organization_aliases is
  'Normalized input aliases used to resolve a profile to a canonical organization.';
comment on column public.certificates.organization is
  'Immutable organization-name snapshot captured when this certificate was issued.';
