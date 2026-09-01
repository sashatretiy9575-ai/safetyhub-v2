-- Locale, profile preference and immutable legal-copy contracts.
-- Existing Russian routes/data remain compatible during the rolling deployment.

create type public.app_locale as enum ('ru', 'kk', 'en', 'zh');

alter table public.profiles
  add column preferred_locale public.app_locale not null default 'ru';

create index profiles_preferred_locale_idx
  on public.profiles (preferred_locale, id);

create table public.legal_document_localizations (
  document_type public.legal_document_type not null,
  version text not null,
  locale public.app_locale not null,
  title text not null,
  body jsonb not null,
  body_hash text not null,
  status text not null default 'draft',
  published_at timestamptz,
  published_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (document_type, version, locale),
  foreign key (document_type, version)
    references public.legal_document_versions(document_type, version) on delete restrict,
  constraint legal_document_localization_title_budget
    check (char_length(title) between 3 and 200),
  constraint legal_document_localization_body_budget
    check (
      jsonb_typeof(body) = 'object'
      and pg_column_size(body) between 2 and 262144
    ),
  constraint legal_document_localization_hash_shape
    check (body_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_document_localization_status
    check (status in ('draft', 'complete', 'published')),
  constraint legal_document_localization_publish_shape
    check (
      (status = 'published' and published_at is not null)
      or (status <> 'published' and published_at is null and published_by is null)
    )
);

create index legal_document_localizations_published_idx
  on public.legal_document_localizations (
    document_type, locale, version
  ) where status = 'published';

insert into public.legal_document_localizations (
  document_type,
  version,
  locale,
  title,
  body,
  body_hash,
  status,
  published_at
)
select
  legal.document_type,
  legal.version,
  'ru'::public.app_locale,
  case legal.document_type
    when 'privacy'::public.legal_document_type then 'Политика конфиденциальности'
    else 'Условия использования'
  end,
  jsonb_build_object('bodyRevision', legal.body_revision),
  encode(
    extensions.digest(
      convert_to(
        jsonb_build_object('bodyRevision', legal.body_revision)::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ),
  'published',
  legal.effective_at
from public.legal_document_versions legal
on conflict (document_type, version, locale) do nothing;

create function private.protect_published_legal_localization()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.status = 'published' then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and old.status = 'published' and (
    new.document_type,
    new.version,
    new.locale,
    new.title,
    new.body,
    new.body_hash,
    new.published_at,
    new.published_by
  ) is distinct from (
    old.document_type,
    old.version,
    old.locale,
    old.title,
    old.body,
    old.body_hash,
    old.published_at,
    old.published_by
  ) then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger legal_document_localizations_immutable
before update or delete on public.legal_document_localizations
for each row execute function private.protect_published_legal_localization();

create trigger legal_document_localizations_set_updated_at
before update on public.legal_document_localizations
for each row execute function private.set_updated_at();

create function public.set_preferred_locale(p_locale public.app_locale)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
begin
  update public.profiles
  set preferred_locale = p_locale
  where id = v_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'PROFILE_NOT_FOUND';
  end if;
  return jsonb_build_object('locale', p_locale);
end;
$$;

create function public.get_legal_document_localization(
  p_document_type public.legal_document_type,
  p_version text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'type', localization.document_type,
    'version', localization.version,
    'locale', localization.locale,
    'title', localization.title,
    'body', localization.body,
    'bodyHash', localization.body_hash,
    'effectiveAt', legal.effective_at
  )
  into v_result
  from public.legal_document_localizations localization
  join public.legal_document_versions legal
    on legal.document_type = localization.document_type
   and legal.version = localization.version
  where localization.document_type = p_document_type
    and localization.version = coalesce(
      nullif(btrim(p_version), ''),
      (
        select current_legal.version
        from public.legal_document_versions current_legal
        where current_legal.document_type = p_document_type
          and current_legal.is_current
      )
    )
    and localization.locale = p_locale
    and localization.status = 'published';
  if v_result is null then
    raise exception using errcode = 'no_data_found',
      message = 'LEGAL_LOCALIZATION_NOT_FOUND';
  end if;
  return v_result;
end;
$$;

create function public.save_legal_document_localization(
  p_document_type public.legal_document_type,
  p_version text,
  p_locale public.app_locale,
  p_title text,
  p_body jsonb,
  p_body_hash text,
  p_complete boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_row public.legal_document_localizations%rowtype;
  v_computed_hash text;
begin
  v_computed_hash := case
    when jsonb_typeof(p_body) = 'object' then
      encode(
        extensions.digest(convert_to(p_body::text, 'UTF8'), 'sha256'),
        'hex'
      )
    else null
  end;
  if p_title is null or char_length(btrim(p_title)) not between 3 and 200
    or jsonb_typeof(p_body) is distinct from 'object'
    or pg_column_size(p_body) > 262144
    or (
      p_body_hash is not null
      and lower(btrim(p_body_hash)) is distinct from v_computed_hash
    ) then
    raise exception using errcode = 'check_violation',
      message = 'LEGAL_LOCALIZATION_INVALID';
  end if;
  insert into public.legal_document_localizations (
    document_type, version, locale, title, body, body_hash, status
  ) values (
    p_document_type, p_version, p_locale, btrim(p_title), p_body,
    v_computed_hash, case when p_complete then 'complete' else 'draft' end
  )
  on conflict (document_type, version, locale) do update
  set title = excluded.title,
      body = excluded.body,
      body_hash = excluded.body_hash,
      status = excluded.status,
      published_at = null,
      published_by = null
  where public.legal_document_localizations.status <> 'published'
  returning * into v_row;
  if v_row.locale is null then
    raise exception using errcode = 'object_in_use',
      message = 'PUBLISHED_LEGAL_LOCALIZATION_IMMUTABLE';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'legal.localization_saved',
    'legal_document_localization',
    p_document_type::text || ':' || p_version || ':' || p_locale::text,
    jsonb_build_object(
      'documentType', p_document_type,
      'version', p_version,
      'locale', p_locale,
      'status', v_row.status,
      'bodyHash', v_row.body_hash
    )
  );
  return jsonb_build_object(
    'type', v_row.document_type,
    'version', v_row.version,
    'locale', v_row.locale,
    'status', v_row.status,
    'bodyHash', v_row.body_hash
  );
end;
$$;

alter table public.legal_document_localizations enable row level security;

revoke all on public.legal_document_localizations
  from public, anon, authenticated;
grant select, insert, update, delete on public.legal_document_localizations
  to service_role;

revoke all on function private.protect_published_legal_localization()
  from public, anon, authenticated, service_role;
revoke all on function public.set_preferred_locale(public.app_locale)
  from public, anon, authenticated, service_role;
revoke all on function public.get_legal_document_localization(
  public.legal_document_type,text,public.app_locale
) from public, anon, authenticated, service_role;
revoke all on function public.save_legal_document_localization(
  public.legal_document_type,text,public.app_locale,text,jsonb,text,boolean
) from public, anon, authenticated, service_role;

grant execute on function public.set_preferred_locale(public.app_locale)
  to authenticated;
grant execute on function public.get_legal_document_localization(
  public.legal_document_type,text,public.app_locale
) to anon, authenticated;
grant execute on function public.save_legal_document_localization(
  public.legal_document_type,text,public.app_locale,text,jsonb,text,boolean
) to authenticated;

comment on type public.app_locale is
  'SafetyHub learner locale. Administrative interfaces remain Russian-only.';
comment on table public.legal_document_localizations is
  'Immutable published localized copies linked to one canonical legal version.';
