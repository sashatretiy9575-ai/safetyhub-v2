-- SafetyHub production baseline.
--
-- This migration intentionally replaces the pre-production migration chain.
-- It assumes an empty application schema. PDF and ZIP bytes are never stored.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.app_role as enum ('user', 'admin', 'superadmin');
create type public.account_status as enum ('active', 'suspended');
create type public.article_status as enum ('draft', 'published', 'archived');
create type public.test_status as enum ('draft', 'published', 'archived');
create type public.attempt_status as enum ('started', 'passed', 'failed', 'expired');
create type public.identity_verification_status as enum ('unverified', 'verified', 'revoked');
create type public.certificate_issue_source as enum (
  'manual', 'score_improvement', 'identity_correction'
);
create type public.legal_document_type as enum ('privacy', 'terms');
create type public.legal_acceptance_source as enum ('registration', 'profile');

create function private.normalize_profile_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.btrim(normalize(coalesce(p_value, ''), NFC)),
    '[[:space:]]+',
    ' ',
    'g'
  );
$$;

create function private.normalized_lookup_key(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.lower(private.normalize_profile_text(p_value));
$$;

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  surname text not null default '',
  job text not null default '',
  organization text not null default '',
  avatar_updated_at timestamptz,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint profiles_name_length check (char_length(name) <= 80),
  constraint profiles_surname_length check (char_length(surname) <= 80),
  constraint profiles_job_length check (char_length(job) <= 160),
  constraint profiles_organization_length check (char_length(organization) <= 160)
);

create table public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'user',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

create table public.account_controls (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status public.account_status not null default 'active',
  deletion_pending boolean not null default false,
  suspended_at timestamptz,
  suspended_by uuid references auth.users(id) on delete set null,
  suspension_reason text,
  updated_at timestamptz not null default statement_timestamp(),
  constraint account_suspension_reason_length
    check (suspension_reason is null or char_length(suspension_reason) between 3 and 500)
);

create table public.admin_capability_catalog (
  capability text primary key,
  category text not null,
  label text not null,
  admin_default boolean not null default false,
  sensitive boolean not null default false,
  constraint capability_name_shape check (capability ~ '^[a-z][a-z0-9_.]{2,79}$')
);

create table public.user_capabilities (
  user_id uuid not null references auth.users(id) on delete cascade,
  capability text not null references public.admin_capability_catalog(capability) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  primary key (user_id, capability)
);

insert into public.admin_capability_catalog
  (capability, category, label, admin_default, sensitive)
values
  ('content.manage', 'content', 'Управление материалами', true, false),
  ('test.manage', 'content', 'Управление тестами', true, false),
  ('support.view', 'support', 'Просмотр обращений', false, false),
  ('user.read', 'users', 'Просмотр участников', true, false),
  ('user.invite', 'users', 'Приглашение участников', true, true),
  ('user.suspend', 'users', 'Приостановка аккаунтов', true, true),
  ('user.delete', 'users', 'Полное удаление аккаунтов', false, true),
  ('role.manage', 'access', 'Управление ролями', false, true),
  ('identity.read', 'identity', 'Просмотр данных участников', true, false),
  ('identity.manage', 'identity', 'Подтверждение и исправление данных', true, true),
  ('certificate.read', 'certificate', 'Просмотр сертификатов', true, false),
  ('certificate.issue', 'certificate', 'Выдача сертификатов', true, true),
  ('certificate.revoke', 'certificate', 'Отзыв сертификатов', true, true),
  ('results.read', 'results', 'Просмотр результатов', true, false),
  ('results.export', 'results', 'Экспорт результатов', true, true),
  ('audit.read', 'audit', 'Просмотр аудита', false, true),
  ('capability.manage', 'access', 'Управление полномочиями', false, true),
  ('site.settings.manage', 'site', 'Изменение телефона и WhatsApp', true, true);

create table public.verified_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status public.identity_verification_status not null default 'unverified',
  version integer not null default 0,
  name text not null default '',
  surname text not null default '',
  job text not null default '',
  organization text not null default '',
  verified_at timestamptz,
  verified_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoke_reason text,
  constraint verified_identity_version_positive check (version >= 0),
  constraint verified_identity_shape check (
    (status = 'unverified' and version = 0 and verified_at is null and revoked_at is null)
    or
    (status = 'verified' and version > 0 and verified_at is not null and revoked_at is null
      and char_length(name) between 1 and 80
      and char_length(surname) between 1 and 80
      and char_length(job) between 1 and 160
      and char_length(organization) between 1 and 160)
    or
    (status = 'revoked' and version > 0 and verified_at is not null and revoked_at is not null
      and char_length(coalesce(revoke_reason, '')) between 3 and 500)
  )
);

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  cover_image text not null default '',
  blocks jsonb not null default '[]'::jsonb,
  status public.article_status not null default 'draft',
  is_published boolean not null default false,
  published_at timestamptz,
  jurisdiction text,
  effective_date date,
  reviewer text,
  reviewed_at timestamptz,
  next_review_at timestamptz,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null default repeat('0', 64),
  reviewed_content_hash text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint article_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint article_blocks_budget check (
    jsonb_typeof(blocks) = 'array'
    and jsonb_array_length(blocks) <= 100
    and pg_column_size(blocks) <= 131072
  ),
  constraint article_content_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint article_reviewed_hash_shape check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'
  )
);

create table public.article_slug_redirects (
  old_slug text primary key,
  article_id uuid not null references public.articles(id) on delete cascade,
  created_at timestamptz not null default statement_timestamp()
);

create table public.tests (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  draft_content jsonb not null default '{"questions":[]}'::jsonb,
  current_revision_id uuid,
  content_version integer not null default 0,
  duration_minutes integer not null default 5,
  pass_score integer not null default 4,
  status public.test_status not null default 'draft',
  jurisdiction text,
  effective_date date,
  reviewer text,
  reviewed_at timestamptz,
  next_review_at timestamptz,
  sources jsonb not null default '[]'::jsonb,
  content_hash text not null default repeat('0', 64),
  reviewed_content_hash text,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint test_slug_shape check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  constraint test_duration_range check (duration_minutes between 1 and 120),
  constraint test_pass_score_range check (pass_score between 1 and 100),
  constraint test_version_nonnegative check (content_version >= 0),
  constraint test_draft_shape check (
    jsonb_typeof(draft_content) = 'object'
    and jsonb_typeof(draft_content -> 'questions') = 'array'
    and jsonb_array_length(draft_content -> 'questions') <= 100
    and pg_column_size(draft_content) <= 262144
  ),
  constraint test_content_hash_shape check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint test_reviewed_hash_shape check (
    reviewed_content_hash is null or reviewed_content_hash ~ '^[0-9a-f]{64}$'
  )
);

create table public.test_revisions (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests(id) on delete cascade,
  version integer not null,
  slug text not null,
  title text not null,
  description text not null,
  questions jsonb not null,
  question_count integer not null,
  duration_minutes integer not null,
  pass_score integer not null,
  published_at timestamptz not null default statement_timestamp(),
  published_by uuid,
  unique (test_id, version),
  constraint revision_version_positive check (version > 0),
  constraint revision_question_count check (question_count between 1 and 100),
  constraint revision_questions_shape check (
    jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) = question_count
    and pg_column_size(questions) <= 262144
  ),
  constraint revision_pass_score check (pass_score between 1 and question_count),
  constraint revision_duration check (duration_minutes between 1 and 120)
);

alter table public.tests
  add constraint tests_current_revision_fk
  foreign key (current_revision_id) references public.test_revisions(id) on delete set null;

create table private.test_revision_answer_keys (
  revision_id uuid primary key references public.test_revisions(id) on delete cascade,
  correct_positions smallint[] not null,
  explanations text[] not null,
  constraint revision_answer_key_cardinality check (
    cardinality(correct_positions) = cardinality(explanations)
    and cardinality(correct_positions) between 1 and 100
  )
);

create table public.test_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  status public.attempt_status not null default 'started',
  answers smallint[],
  score integer,
  started_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  completed_at timestamptz,
  constraint attempt_deadline_after_start check (expires_at > started_at),
  constraint attempt_completion_shape check (
    (status = 'started' and answers is null and score is null and completed_at is null)
    or (status = 'expired' and score is null and completed_at is not null)
    or (status in ('passed', 'failed') and answers is not null and score is not null
      and score >= 0 and completed_at is not null)
  )
);

create table public.attestations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  best_attempt_id uuid not null references public.test_attempts(id) on delete cascade,
  best_score integer not null check (best_score >= 0),
  best_completed_at timestamptz not null,
  updated_at timestamptz not null default statement_timestamp(),
  unique (user_id, revision_id)
);

create table public.certificates (
  id uuid primary key default gen_random_uuid(),
  certificate_number text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  attestation_id uuid not null references public.attestations(id) on delete cascade,
  attempt_id uuid not null references public.test_attempts(id) on delete cascade,
  identity_version integer not null,
  full_name text not null,
  job text not null,
  organization text not null,
  test_slug text not null,
  test_title text not null,
  score integer not null,
  total integer not null,
  pass_score integer not null,
  best_completed_at timestamptz not null,
  issued_at timestamptz not null default statement_timestamp(),
  issued_by uuid,
  issue_source public.certificate_issue_source not null default 'manual',
  supersedes_certificate_id uuid,
  template_version integer not null default 1,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text,
  constraint certificate_score_shape check (
    total > 0 and pass_score between 1 and total and score between 0 and total
  ),
  constraint certificate_template_version check (template_version > 0),
  constraint certificate_identity_version check (identity_version > 0),
  constraint certificate_revocation_shape check (
    (revoked_at is null and revoked_by is null and revoke_reason is null)
    or (revoked_at is not null and char_length(coalesce(revoke_reason, '')) between 3 and 500)
  )
);

create table public.legal_document_versions (
  document_type public.legal_document_type not null,
  version text not null,
  body_revision text not null unique,
  effective_at timestamptz not null,
  is_current boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  primary key (document_type, version)
);

create table public.legal_acceptances (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_type public.legal_document_type not null,
  version text not null,
  accepted_at timestamptz not null default statement_timestamp(),
  source public.legal_acceptance_source not null,
  primary key (user_id, document_type, version),
  foreign key (document_type, version)
    references public.legal_document_versions(document_type, version)
);

create unique index legal_one_current_per_type_idx
  on public.legal_document_versions (document_type) where is_current;

insert into public.legal_document_versions
  (document_type, version, body_revision, effective_at, is_current)
values
  ('privacy', '1.1', 'privacy-1.1', timestamptz '2026-08-13 00:00:00+00', true),
  ('terms', '2.1', 'terms-2.1', timestamptz '2026-08-13 00:00:00+00', true);

create function private.protect_legal_document_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if TG_OP = 'UPDATE'
    and coalesce(current_setting('safetyhub.legal_rotation', true), '') = '1'
    and (new.document_type, new.version, new.body_revision, new.effective_at, new.created_at)
      is not distinct from
      (old.document_type, old.version, old.body_revision, old.effective_at, old.created_at)
    and new.is_current is distinct from old.is_current then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'LEGAL_DOCUMENT_VERSION_IMMUTABLE';
end;
$$;

create trigger legal_document_versions_immutable
before update or delete on public.legal_document_versions
for each row execute function private.protect_legal_document_version();

create function private.record_signup_legal_acceptance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acceptance jsonb := coalesce(new.raw_user_meta_data -> 'legalAcceptance', '{}'::jsonb);
begin
  insert into public.legal_acceptances (user_id, document_type, version, source)
  select new.id, document.document_type, document.version, 'registration'
  from public.legal_document_versions document
  where document.is_current
    and (
      (document.document_type = 'privacy'
        and document.version = v_acceptance ->> 'privacyVersion'
        and document.body_revision = v_acceptance ->> 'privacyBodyRevision')
      or
      (document.document_type = 'terms'
        and document.version = v_acceptance ->> 'termsVersion'
        and document.body_revision = v_acceptance ->> 'termsBodyRevision')
    );
  return new;
end;
$$;

create trigger on_auth_user_record_legal_acceptance
after insert on auth.users for each row execute function private.record_signup_legal_acceptance();

create table public.site_settings (
  singleton boolean primary key default true check (singleton),
  phone_e164 text not null,
  phone_display text not null,
  whatsapp_e164 text not null,
  whatsapp_same_as_phone boolean not null default true,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default statement_timestamp(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint site_phone_e164_shape check (
    char_length(phone_e164) between 9 and 16
    and phone_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint site_phone_display_shape check (
    char_length(phone_display) between 8 and 40
    and phone_display !~ '[[:cntrl:]]'
  ),
  constraint site_whatsapp_e164_shape check (
    char_length(whatsapp_e164) between 9 and 16
    and whatsapp_e164 ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint site_same_number_consistency check (
    not whatsapp_same_as_phone or whatsapp_e164 = phone_e164
  )
);

insert into public.site_settings
  (singleton, phone_e164, phone_display, whatsapp_e164, whatsapp_same_as_phone)
values (true, '+77017290349', '+7 701 729 0349', '+77017290349', true);

create table public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete cascade,
  action text not null,
  target_type text not null,
  target_id text,
  before_data jsonb,
  after_data jsonb,
  reason text,
  batch_id uuid,
  correlation_id uuid not null default gen_random_uuid(),
  request_id text,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default statement_timestamp(),
  constraint audit_action_shape check (action ~ '^[a-z][a-z0-9_.]{2,99}$'),
  constraint audit_reason_length check (reason is null or char_length(reason) <= 500),
  constraint audit_user_agent_length check (user_agent is null or char_length(user_agent) <= 256)
);

create table private.business_rate_limits (
  actor_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_started_at timestamptz not null,
  consumed integer not null default 0,
  primary key (actor_id, action)
);

create table private.coarse_ip_rate_limits (
  ip_hash text not null,
  action text not null,
  window_started_at timestamptz not null,
  consumed integer not null default 0,
  primary key (ip_hash, action)
);

create table private.password_change_contexts (
  token_hash text primary key,
  user_id uuid references auth.users(id) on delete cascade,
  purpose text not null check (purpose in ('invite', 'recovery')),
  session_id uuid,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default statement_timestamp()
);

create table private.auth_admin_outbox (
  id uuid primary key default gen_random_uuid(),
  operation_type text not null check (operation_type in ('invite', 'suspend', 'restore')),
  state text not null default 'prepared' check (
    state in ('prepared', 'external_succeeded', 'committed', 'retryable', 'rolled_back', 'failed')
  ),
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid,
  payload jsonb not null default '{}'::jsonb,
  completion_token_hash text not null,
  attempts integer not null default 0,
  last_error text,
  correlation_id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp()
);

-- Query indexes: keep only indexes used by owner reads, the rolling-window
-- limit, attestation keyset pages, certificate state and audit investigations.
create index profiles_name_lookup_idx on public.profiles (
  private.normalized_lookup_key(surname), private.normalized_lookup_key(name), id
);
create index profiles_organization_lookup_idx on public.profiles (
  private.normalized_lookup_key(organization), private.normalized_lookup_key(surname), id
);
create index profiles_full_name_trgm_idx on public.profiles using gin (
  private.normalized_lookup_key(name || ' ' || surname) extensions.gin_trgm_ops
);
create index profiles_organization_trgm_idx on public.profiles using gin (
  private.normalized_lookup_key(organization) extensions.gin_trgm_ops
);
create index articles_public_idx on public.articles (published_at desc, id)
  where is_published;
create index tests_public_idx on public.tests (created_at, id)
  where status = 'published';
create index test_revisions_test_version_idx on public.test_revisions (test_id, version desc);
create unique index test_attempts_one_started_idx
  on public.test_attempts (user_id, revision_id) where status = 'started';
create index test_attempts_rolling_limit_idx
  on public.test_attempts (user_id, revision_id, started_at desc);
create index test_attempts_expiry_idx on public.test_attempts (expires_at, id)
  where status = 'started';
create index attestations_completed_idx
  on public.attestations (best_completed_at desc, id desc);
create index attestations_score_idx
  on public.attestations (best_score desc, best_completed_at desc, id desc);
create index attestations_revision_user_idx on public.attestations (revision_id, user_id);
create unique index certificates_one_active_cycle_idx
  on public.certificates (user_id, revision_id) where revoked_at is null;
create index certificates_cycle_latest_idx
  on public.certificates (
    user_id, revision_id, (revoked_at is null) desc, issued_at desc, id desc
  );
create index certificates_supersedes_idx on public.certificates (supersedes_certificate_id)
  where supersedes_certificate_id is not null;
create index audit_created_idx on public.admin_audit_log (created_at desc, id desc);
create index audit_actor_idx on public.admin_audit_log (actor_user_id, created_at desc);
create index audit_target_idx on public.admin_audit_log (target_user_id, created_at desc);
create index audit_correlation_idx on public.admin_audit_log (correlation_id, created_at);
create index audit_action_idx on public.admin_audit_log (action, created_at desc);

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function private.set_updated_at();
create trigger roles_set_updated_at before update on public.user_roles
for each row execute function private.set_updated_at();
create trigger articles_set_updated_at before update on public.articles
for each row execute function private.set_updated_at();
create trigger tests_set_updated_at before update on public.tests
for each row execute function private.set_updated_at();
create trigger outbox_set_updated_at before update on private.auth_admin_outbox
for each row execute function private.set_updated_at();

create function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = TG_TABLE_NAME || '_IMMUTABLE';
end;
$$;

create trigger test_revisions_immutable
before update or delete on public.test_revisions
for each row execute function private.reject_immutable_row_change();

create trigger test_revision_answer_keys_immutable
before update or delete on private.test_revision_answer_keys
for each row execute function private.reject_immutable_row_change();

create function private.guard_certificate_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attestation public.attestations%rowtype;
  v_revision public.test_revisions%rowtype;
  v_identity public.verified_identities%rowtype;
  v_predecessor public.certificates%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if (new.id, new.certificate_number, new.user_id, new.revision_id,
        new.attestation_id, new.attempt_id, new.identity_version, new.full_name,
        new.job, new.organization, new.test_slug, new.test_title, new.score,
        new.total, new.pass_score, new.best_completed_at, new.issued_at,
        new.issued_by, new.issue_source, new.supersedes_certificate_id,
        new.template_version)
      is distinct from
       (old.id, old.certificate_number, old.user_id, old.revision_id,
        old.attestation_id, old.attempt_id, old.identity_version, old.full_name,
        old.job, old.organization, old.test_slug, old.test_title, old.score,
        old.total, old.pass_score, old.best_completed_at, old.issued_at,
        old.issued_by, old.issue_source, old.supersedes_certificate_id,
        old.template_version) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_SNAPSHOT_IMMUTABLE';
    end if;
    if old.revoked_at is not null
      and (new.revoked_at, new.revoked_by, new.revoke_reason)
        is distinct from (old.revoked_at, old.revoked_by, old.revoke_reason) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_REVOCATION_IMMUTABLE';
    end if;
    if new.revoked_at is null
      and (new.revoked_by is not null or new.revoke_reason is not null) then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_REVOCATION_INVALID';
    end if;
    if new.revoked_at is not null and char_length(coalesce(new.revoke_reason, '')) < 3 then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_REVOKE_REASON_REQUIRED';
    end if;
    return new;
  end if;

  select * into v_attestation from public.attestations where id = new.attestation_id;
  select * into v_revision from public.test_revisions where id = new.revision_id;
  select * into v_identity from public.verified_identities where user_id = new.user_id;
  if v_attestation.id is null or v_revision.id is null
    or v_attestation.user_id <> new.user_id
    or v_attestation.revision_id <> new.revision_id
    or v_attestation.best_attempt_id <> new.attempt_id
    or v_attestation.best_score <> new.score
    or v_attestation.best_completed_at <> new.best_completed_at
    or v_revision.question_count <> new.total
    or v_revision.pass_score <> new.pass_score
    or v_revision.slug <> new.test_slug
    or v_revision.title <> new.test_title
    or new.score < new.pass_score
    or v_identity.status <> 'verified'
    or v_identity.version <> new.identity_version
    or concat_ws(' ', v_identity.name, v_identity.surname) <> new.full_name
    or v_identity.job <> new.job
    or v_identity.organization <> new.organization then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CERTIFICATE_SNAPSHOT_INVALID';
  end if;
  if new.issue_source = 'manual' and new.supersedes_certificate_id is not null then
    raise exception using errcode = 'check_violation', message = 'CERTIFICATE_LINEAGE_INVALID';
  end if;
  if new.issue_source <> 'manual' then
    if new.supersedes_certificate_id is null then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_PREDECESSOR_REQUIRED';
    end if;
    select * into v_predecessor
    from public.certificates where id = new.supersedes_certificate_id;
    if v_predecessor.id is null
      or v_predecessor.user_id <> new.user_id
      or v_predecessor.revision_id <> new.revision_id
      or v_predecessor.revoked_at is null then
      raise exception using errcode = 'check_violation', message = 'CERTIFICATE_LINEAGE_INVALID';
    end if;
    if new.issue_source = 'score_improvement' and new.score <= v_predecessor.score then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_SCORE_IMPROVEMENT_REQUIRED';
    end if;
    if new.issue_source = 'identity_correction'
      and (new.attestation_id <> v_predecessor.attestation_id
        or new.score <> v_predecessor.score
        or new.identity_version <= v_predecessor.identity_version) then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_IDENTITY_CORRECTION_INVALID';
    end if;
    if exists (
      select 1
      from public.certificates newer_predecessor
      where newer_predecessor.user_id = new.user_id
        and newer_predecessor.revision_id = new.revision_id
        and newer_predecessor.revoked_at is not null
        and (newer_predecessor.issued_at, newer_predecessor.id)
          > (v_predecessor.issued_at, v_predecessor.id)
    ) then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_PREDECESSOR_NOT_LATEST';
    end if;
  end if;
  return new;
end;
$$;

create trigger certificates_snapshot_guard
before insert or update on public.certificates
for each row execute function private.guard_certificate_snapshot();

create function private.audit_direct_role_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.role is distinct from old.role
    and coalesce(current_setting('safetyhub.skip_role_audit', true), '') <> '1' then
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      before_data, after_data
    ) values (
      (select auth.uid()), new.user_id, 'role.changed_directly', 'user', new.user_id::text,
      jsonb_build_object('role', old.role), jsonb_build_object('role', new.role)
    );
  end if;
  return new;
end;
$$;

create trigger user_roles_audit_direct_change
after update of role on public.user_roles
for each row execute function private.audit_direct_role_change();

create function private.normalize_profile_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.name := private.normalize_profile_text(new.name);
  new.surname := private.normalize_profile_text(new.surname);
  new.job := private.normalize_profile_text(new.job);
  new.organization := private.normalize_profile_text(new.organization);
  if new.name ~ '[[:cntrl:]]' or new.surname ~ '[[:cntrl:]]'
    or new.job ~ '[[:cntrl:]]' or new.organization ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation', message = 'PROFILE_CONTROL_CHARACTER';
  end if;
  return new;
end;
$$;

create trigger profiles_normalize before insert or update of name, surname, job, organization
on public.profiles for each row execute function private.normalize_profile_row();

create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, name, surname, job)
  values (
    new.id,
    private.normalize_profile_text(new.raw_user_meta_data ->> 'name'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'surname'),
    private.normalize_profile_text(new.raw_user_meta_data ->> 'job')
  );
  insert into public.user_roles (user_id) values (new.id);
  insert into public.account_controls (user_id) values (new.id);
  insert into public.verified_identities (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users for each row execute function private.handle_new_user();

create function private.actor_has_capability(p_actor_id uuid, p_capability text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.user_roles role
    join public.account_controls control on control.user_id = role.user_id
    join public.admin_capability_catalog catalog on catalog.capability = p_capability
    where role.user_id = p_actor_id
      and control.status = 'active'
      and not control.deletion_pending
      and (
        role.role = 'superadmin'
        or (role.role = 'admin' and (
          catalog.admin_default
          or exists (
            select 1 from public.user_capabilities assignment
            where assignment.user_id = p_actor_id
              and assignment.capability = p_capability
          )
        ))
      )
  );
$$;

create function private.actor_has_any_capability(p_actor_id uuid, p_capabilities text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from unnest(coalesce(p_capabilities, '{}'::text[])) capability
    where private.actor_has_capability(p_actor_id, capability)
  );
$$;

create function private.require_capability(p_capability text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
begin
  if v_actor_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  if not private.actor_has_capability(v_actor_id, p_capability) then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_REQUIRED';
  end if;
  return v_actor_id;
end;
$$;

create function private.require_any_capability(p_capabilities text[])
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
begin
  if v_actor_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  if not private.actor_has_any_capability(v_actor_id, p_capabilities) then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_REQUIRED';
  end if;
  return v_actor_id;
end;
$$;

create function private.require_active_user()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
begin
  if v_user_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  if not exists (
    select 1
    from public.account_controls control
    where control.user_id = v_user_id
      and control.status = 'active'
      and not control.deletion_pending
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;
  return v_user_id;
end;
$$;

create function private.identity_state(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when identity.status = 'revoked' then 'revoked'
    when identity.status <> 'verified' then 'pending'
    when (identity.name, identity.surname, identity.job, identity.organization)
      is distinct from (profile.name, profile.surname, profile.job, profile.organization)
      then 'changed'
    else 'verified'
  end
  from public.profiles profile
  join public.verified_identities identity on identity.user_id = profile.id
  where profile.id = p_user_id;
$$;

create function private.has_current_legal_acceptance(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) = 2 and count(acceptance.user_id) = 2
  from public.legal_document_versions document
  left join public.legal_acceptances acceptance
    on acceptance.user_id = p_user_id
   and acceptance.document_type = document.document_type
   and acceptance.version = document.version
  where document.is_current
    and document.document_type in ('privacy', 'terms');
$$;

create function public.get_my_capabilities()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(catalog.capability order by catalog.capability), '{}'::text[])
  from public.admin_capability_catalog catalog
  where private.actor_has_capability((select auth.uid()), catalog.capability);
$$;

create function public.get_auth_context()
returns table (
  user_id uuid,
  email text,
  profile_id uuid,
  profile_name text,
  profile_surname text,
  profile_job text,
  profile_organization text,
  profile_avatar_updated_at timestamptz,
  profile_onboarding_completed_at timestamptz,
  profile_identity_state text,
  profile_created_at timestamptz,
  profile_updated_at timestamptz,
  role public.app_role,
  status public.account_status,
  deletion_pending boolean,
  capabilities text[],
  has_current_legal_acceptance boolean
)
language sql
stable
security definer
set search_path = ''
rows 1
as $$
  select
    auth_user.id,
    auth_user.email::text,
    profile.id,
    profile.name,
    profile.surname,
    profile.job,
    profile.organization,
    profile.avatar_updated_at,
    profile.onboarding_completed_at,
    private.identity_state(profile.id),
    profile.created_at,
    profile.updated_at,
    user_role.role,
    control.status,
    control.deletion_pending,
    public.get_my_capabilities(),
    private.has_current_legal_acceptance(profile.id)
  from auth.users auth_user
  join public.profiles profile on profile.id = auth_user.id
  join public.user_roles user_role on user_role.user_id = auth_user.id
  join public.account_controls control on control.user_id = auth_user.id
  where auth_user.id = (select auth.uid())
    and auth_user.deleted_at is null
    and (auth_user.banned_until is null or auth_user.banned_until <= statement_timestamp());
$$;

create function public.update_profile(
  p_name text,
  p_surname text,
  p_job text,
  p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_profile public.profiles%rowtype;
  v_name text := private.normalize_profile_text(p_name);
  v_surname text := private.normalize_profile_text(p_surname);
  v_job text := private.normalize_profile_text(p_job);
  v_organization text := private.normalize_profile_text(p_organization);
begin
  if char_length(v_name) not between 1 and 80
    or char_length(v_surname) not between 1 and 80
    or char_length(v_job) not between 1 and 160
    or char_length(v_organization) not between 1 and 160
    or v_name ~ '[[:cntrl:]]' or v_surname ~ '[[:cntrl:]]'
    or v_job ~ '[[:cntrl:]]' or v_organization ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation', message = 'PROFILE_FIELDS_REQUIRED';
  end if;
  update public.profiles
  set name = v_name, surname = v_surname, job = v_job, organization = v_organization
  where id = v_user_id
  returning * into v_profile;
  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'job', v_profile.job,
      'organization', v_profile.organization,
      'avatarUpdatedAt', v_profile.avatar_updated_at,
      'onboardingCompletedAt', v_profile.onboarding_completed_at,
      'createdAt', v_profile.created_at,
      'updatedAt', v_profile.updated_at
    ),
    'identityState', private.identity_state(v_user_id)
  );
end;
$$;

create function public.complete_profile_onboarding(
  p_name text,
  p_surname text,
  p_job text,
  p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_result jsonb;
begin
  if not exists (
    select 1 from public.profiles profile
    where profile.id = v_user_id and profile.avatar_updated_at is not null
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
  end if;
  v_result := public.update_profile(p_name, p_surname, p_job, p_organization);
  update public.profiles
  set onboarding_completed_at = coalesce(onboarding_completed_at, statement_timestamp())
  where id = v_user_id;
  return v_result || jsonb_build_object('completed', true);
end;
$$;

create function public.mark_profile_avatar_uploaded(
  p_user_id uuid,
  p_uploaded_at timestamptz default statement_timestamp()
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_value timestamptz;
begin
  update public.profiles
  set avatar_updated_at = coalesce(p_uploaded_at, statement_timestamp())
  where id = p_user_id
  returning avatar_updated_at into v_value;
  if v_value is null then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  return v_value;
end;
$$;

create function public.search_profile_organizations(p_query text, p_limit integer default 8)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(candidate.organization order by candidate.frequency desc, candidate.organization), '{}'::text[])
  from (
    select min(profile.organization) as organization, count(*) as frequency
    from public.profiles profile
    where (select auth.uid()) is not null
      and nullif(private.normalized_lookup_key(profile.organization), '') is not null
      and private.normalized_lookup_key(profile.organization)
        like '%' || private.normalized_lookup_key(p_query) || '%'
    group by private.normalized_lookup_key(profile.organization)
    order by count(*) desc, min(profile.organization)
    limit least(greatest(coalesce(p_limit, 8), 1), 20)
  ) candidate;
$$;

create function public.mark_signup_legal_acceptance(
  p_user_id uuid,
  p_privacy_version text,
  p_terms_version text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.legal_acceptances (user_id, document_type, version, source)
  values
    (p_user_id, 'privacy', p_privacy_version, 'registration'),
    (p_user_id, 'terms', p_terms_version, 'registration')
  on conflict do nothing;
end;
$$;

create function public.publish_legal_document_version(
  p_document_type public.legal_document_type,
  p_version text,
  p_body_revision text,
  p_effective_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if char_length(btrim(p_version)) not between 1 and 32
    or char_length(btrim(p_body_revision)) not between 3 and 160
    or p_effective_at is null then
    raise exception using errcode = 'check_violation', message = 'LEGAL_VERSION_INVALID';
  end if;
  if exists (
    select 1 from public.legal_document_versions document
    where document.document_type = p_document_type and document.version = btrim(p_version)
  ) then
    raise exception using errcode = 'unique_violation', message = 'LEGAL_VERSION_EXISTS';
  end if;
  perform set_config('safetyhub.legal_rotation', '1', true);
  update public.legal_document_versions
  set is_current = false
  where document_type = p_document_type and is_current;
  insert into public.legal_document_versions (
    document_type, version, body_revision, effective_at, is_current
  ) values (
    p_document_type, btrim(p_version), btrim(p_body_revision), p_effective_at, true
  );
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    null, 'legal.version_published', 'legal_document', p_document_type::text,
    jsonb_build_object('version', btrim(p_version), 'bodyRevision', btrim(p_body_revision))
  );
  return jsonb_build_object(
    'documentType', p_document_type,
    'version', btrim(p_version),
    'bodyRevision', btrim(p_body_revision),
    'effectiveAt', p_effective_at
  );
end;
$$;

create function public.accept_current_legal_documents(
  p_privacy_version text,
  p_privacy_body_revision text,
  p_terms_version text,
  p_terms_body_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_result jsonb;
begin
  perform 1
  from public.legal_document_versions privacy,
       public.legal_document_versions terms
  where privacy.document_type = 'privacy'
    and privacy.version = p_privacy_version
    and privacy.body_revision = p_privacy_body_revision
    and privacy.is_current
    and terms.document_type = 'terms'
    and terms.version = p_terms_version
    and terms.body_revision = p_terms_body_revision
    and terms.is_current
  for share of privacy, terms;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_VERSION_OUTDATED';
  end if;
  insert into public.legal_acceptances (user_id, document_type, version, source)
  values
    (v_user_id, 'privacy', p_privacy_version, 'profile'),
    (v_user_id, 'terms', p_terms_version, 'profile')
  on conflict do nothing;
  select jsonb_agg(jsonb_build_object(
    'documentType', acceptance.document_type,
    'version', acceptance.version,
    'acceptedAt', acceptance.accepted_at,
    'source', acceptance.source
  ) order by acceptance.document_type, acceptance.accepted_at desc)
  into v_result
  from public.legal_acceptances acceptance
  where acceptance.user_id = v_user_id;
  return coalesce(v_result, '[]'::jsonb);
end;
$$;

create function private.article_content_hash(
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(
    convert_to(jsonb_build_object(
      'title', p_title,
      'description', p_description,
      'coverImage', p_cover_image,
      'blocks', p_blocks
    )::text, 'utf8'),
    'sha256'
  ), 'hex');
$$;

create function public.save_article_draft(
  p_article_id uuid,
  p_original_slug text,
  p_slug text,
  p_title text,
  p_description text,
  p_cover_image text,
  p_blocks jsonb,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_article public.articles%rowtype;
  v_slug text := lower(btrim(p_slug));
  v_hash text;
begin
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 120
    or char_length(btrim(p_title)) not between 3 and 200
    or jsonb_typeof(p_blocks) <> 'array'
    or jsonb_array_length(p_blocks) > 100
    or pg_column_size(p_blocks) > 131072 then
    raise exception using errcode = 'check_violation', message = 'ARTICLE_DRAFT_INVALID';
  end if;
  v_hash := private.article_content_hash(
    btrim(p_title), coalesce(btrim(p_description), ''), coalesce(btrim(p_cover_image), ''), p_blocks
  );
  if p_article_id is null then
    insert into public.articles (
      slug, title, description, cover_image, blocks, status, is_published,
      jurisdiction, effective_date, reviewer, reviewed_at, next_review_at, sources,
      content_hash, reviewed_content_hash, created_by, updated_by
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(btrim(p_cover_image), ''), p_blocks, 'draft', false,
      nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
      nullif(p_review_metadata ->> 'effectiveDate', '')::date,
      nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
      nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
      nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
      coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
      v_hash, null, v_actor_id, v_actor_id
    ) returning * into v_article;
  else
    select * into v_article from public.articles where id = p_article_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'ARTICLE_NOT_FOUND';
    end if;
    if v_article.slug <> v_slug then
      insert into public.article_slug_redirects (old_slug, article_id)
      values (coalesce(nullif(p_original_slug, ''), v_article.slug), v_article.id)
      on conflict (old_slug) do update set article_id = excluded.article_id;
    end if;
    update public.articles
    set slug = v_slug,
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        cover_image = coalesce(btrim(p_cover_image), ''),
        blocks = p_blocks,
        status = 'draft',
        is_published = false,
        jurisdiction = nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_review_metadata ->> 'effectiveDate', '')::date,
        reviewer = nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
        reviewed_at = nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
        next_review_at = nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
        sources = coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
        content_hash = v_hash,
        reviewed_content_hash = null,
        updated_by = v_actor_id
    where id = p_article_id
    returning * into v_article;
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', v_article.id::text, 'article.draft_saved',
    jsonb_build_object('slug', v_article.slug, 'contentHash', v_article.content_hash)
  );
  return jsonb_build_object(
    'id', v_article.id,
    'slug', v_article.slug,
    'status', v_article.status,
    'publishedAt', v_article.published_at
  );
end;
$$;

create function public.set_article_status(
  p_article_id uuid,
  p_status public.article_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_article public.articles%rowtype;
begin
  select * into v_article from public.articles where id = p_article_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ARTICLE_NOT_FOUND';
  end if;
  if p_status = 'published' then
    if v_article.reviewed_at is null or v_article.next_review_at <= statement_timestamp()
      or nullif(v_article.jurisdiction, '') is null
      or nullif(v_article.reviewer, '') is null then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ARTICLE_REVIEW_REQUIRED';
    end if;
  end if;
  update public.articles
  set status = p_status,
      is_published = p_status = 'published',
      published_at = case
        when p_status = 'published' then coalesce(published_at, statement_timestamp())
        else published_at
      end,
      reviewed_content_hash = case
        when p_status = 'published' then content_hash else reviewed_content_hash
      end,
      updated_by = v_actor_id
  where id = p_article_id
  returning * into v_article;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'article', v_article.id::text, 'article.status_changed',
    jsonb_build_object('status', v_article.status)
  );
  return jsonb_build_object(
    'id', v_article.id,
    'slug', v_article.slug,
    'status', v_article.status,
    'publishedAt', v_article.published_at
  );
end;
$$;

create function public.resolve_article_slug(p_old_slug text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select article.slug
  from public.article_slug_redirects redirect
  join public.articles article on article.id = redirect.article_id
  where redirect.old_slug = p_old_slug
    and article.is_published;
$$;

create function private.build_test_revision(
  p_test_id uuid,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_revision_id uuid := gen_random_uuid();
  v_version integer;
  v_public_questions jsonb := '[]'::jsonb;
  v_public_options jsonb;
  v_question jsonb;
  v_option jsonb;
  v_question_id uuid;
  v_option_id uuid;
  v_question_position integer := 0;
  v_option_position integer;
  v_correct integer;
  v_correct_positions smallint[] := '{}'::smallint[];
  v_explanations text[] := '{}'::text[];
  v_questions jsonb;
begin
  select * into v_test from public.tests where id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  v_questions := v_test.draft_content -> 'questions';
  if jsonb_typeof(v_questions) <> 'array' or jsonb_array_length(v_questions) <> 5 then
    raise exception using errcode = 'check_violation', message = 'TEST_QUESTIONS_INVALID';
  end if;
  for v_question in select value from jsonb_array_elements(v_questions)
  loop
    v_question_position := v_question_position + 1;
    v_question_id := gen_random_uuid();
    v_public_options := '[]'::jsonb;
    v_option_position := 0;
    v_correct := coalesce((v_question ->> 'correctOptionIndex')::integer, -1);
    if char_length(btrim(v_question ->> 'text')) < 3
      or jsonb_typeof(v_question -> 'options') <> 'array'
      or jsonb_array_length(v_question -> 'options') not between 2 and 6
      or v_correct < 0
      or v_correct >= jsonb_array_length(v_question -> 'options') then
      raise exception using errcode = 'check_violation', message = 'TEST_QUESTION_INVALID';
    end if;
    for v_option in select value from jsonb_array_elements(v_question -> 'options')
    loop
      if char_length(btrim(v_option #>> '{}')) < 1 then
        raise exception using errcode = 'check_violation', message = 'TEST_OPTION_INVALID';
      end if;
      v_option_id := gen_random_uuid();
      v_public_options := v_public_options || jsonb_build_array(jsonb_build_object(
        'id', v_option_id,
        'text', btrim(v_option #>> '{}'),
        'position', v_option_position + 1
      ));
      v_option_position := v_option_position + 1;
    end loop;
    v_public_questions := v_public_questions || jsonb_build_array(jsonb_build_object(
      'id', v_question_id,
      'text', btrim(v_question ->> 'text'),
      'position', v_question_position,
      'options', v_public_options
    ));
    v_correct_positions := array_append(v_correct_positions, v_correct::smallint);
    v_explanations := array_append(
      v_explanations,
      private.normalize_profile_text(v_question ->> 'explanation')
    );
  end loop;
  v_version := v_test.content_version + 1;
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, questions, question_count,
    duration_minutes, pass_score, published_by
  ) values (
    v_revision_id, v_test.id, v_version, v_test.slug, v_test.title,
    v_test.description, v_public_questions, v_question_position,
    v_test.duration_minutes, least(v_test.pass_score, v_question_position), p_actor_id
  );
  insert into private.test_revision_answer_keys (
    revision_id, correct_positions, explanations
  ) values (v_revision_id, v_correct_positions, v_explanations);
  update public.tests
  set current_revision_id = v_revision_id,
      content_version = v_version,
      status = 'published',
      reviewed_content_hash = content_hash,
      updated_by = p_actor_id
  where id = v_test.id;
  return v_revision_id;
end;
$$;

create function public.save_test_content(
  p_actor_id uuid,
  p_test_id uuid,
  p_slug text,
  p_title text,
  p_description text,
  p_duration_minutes integer,
  p_questions jsonb,
  p_publish boolean,
  p_review_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_test_id uuid;
  v_hash text;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if lower(btrim(p_slug)) !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(btrim(p_title)) not between 3 and 200
    or p_duration_minutes not between 1 and 120
    or jsonb_typeof(p_questions) <> 'array'
    or jsonb_array_length(p_questions) <> 5
    or pg_column_size(p_questions) > 262144 then
    raise exception using errcode = 'check_violation', message = 'TEST_DRAFT_INVALID';
  end if;
  v_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'slug', lower(btrim(p_slug)),
    'title', btrim(p_title),
    'description', coalesce(btrim(p_description), ''),
    'durationMinutes', p_duration_minutes,
    'questions', p_questions
  )::text, 'utf8'), 'sha256'), 'hex');
  if p_test_id is null then
    insert into public.tests (
      slug, title, description, draft_content, duration_minutes, pass_score,
      jurisdiction, effective_date, reviewer, reviewed_at, next_review_at, sources,
      content_hash, created_by, updated_by
    ) values (
      lower(btrim(p_slug)), btrim(p_title), coalesce(btrim(p_description), ''),
      jsonb_build_object('questions', p_questions), p_duration_minutes,
      greatest(1, ceil(jsonb_array_length(p_questions) * 0.8)::integer),
      nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
      nullif(p_review_metadata ->> 'effectiveDate', '')::date,
      nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
      nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
      nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
      coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
      v_hash, v_actor_id, v_actor_id
    ) returning * into v_test;
  else
    update public.tests
    set slug = lower(btrim(p_slug)),
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        draft_content = jsonb_build_object('questions', p_questions),
        duration_minutes = p_duration_minutes,
        pass_score = greatest(1, ceil(jsonb_array_length(p_questions) * 0.8)::integer),
        jurisdiction = nullif(btrim(p_review_metadata ->> 'jurisdiction'), ''),
        effective_date = nullif(p_review_metadata ->> 'effectiveDate', '')::date,
        reviewer = nullif(btrim(p_review_metadata ->> 'reviewer'), ''),
        reviewed_at = nullif(p_review_metadata ->> 'reviewedAt', '')::timestamptz,
        next_review_at = nullif(p_review_metadata ->> 'nextReviewAt', '')::timestamptz,
        sources = coalesce(p_review_metadata -> 'sources', '[]'::jsonb),
        content_hash = v_hash,
        updated_by = v_actor_id
    where id = p_test_id
    returning * into v_test;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
    end if;
  end if;
  v_test_id := v_test.id;
  if p_publish then
    if v_test.reviewed_at is null or v_test.next_review_at <= statement_timestamp()
      or nullif(v_test.jurisdiction, '') is null
      or nullif(v_test.reviewer, '') is null then
      raise exception using errcode = 'object_not_in_prerequisite_state', message = 'TEST_REVIEW_REQUIRED';
    end if;
    perform private.build_test_revision(v_test_id, v_actor_id);
  end if;
  select * into v_test from public.tests where id = v_test_id;
  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'test', v_test_id::text,
    case when p_publish then 'test.published' else 'test.draft_saved' end,
    jsonb_build_object('slug', v_test.slug, 'version', v_test.content_version)
  );
  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_test.slug,
    'status', v_test.status,
    'version', v_test.content_version
  );
end;
$$;

create function public.get_test_editor_payload(p_actor_id uuid, p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_test from public.tests where id = p_test_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_test.slug,
    'title', v_test.title,
    'description', v_test.description,
    'durationMinutes', v_test.duration_minutes,
    'jurisdiction', coalesce(v_test.jurisdiction, ''),
    'effectiveDate', coalesce(v_test.effective_date::text, ''),
    'reviewer', coalesce(v_test.reviewer, ''),
    'reviewedAt', coalesce(v_test.reviewed_at::text, ''),
    'nextReviewAt', coalesce(v_test.next_review_at::text, ''),
    'sources', v_test.sources,
    'status', v_test.status,
    'questions', v_test.draft_content -> 'questions'
  );
end;
$$;

create function public.set_test_status(
  p_actor_id uuid,
  p_test_id uuid,
  p_status public.test_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_test from public.tests where id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  if p_status = 'published' and v_test.current_revision_id is null then
    perform private.build_test_revision(v_test.id, v_actor_id);
  end if;
  update public.tests set status = p_status, updated_by = v_actor_id
  where id = p_test_id returning * into v_test;
  return jsonb_build_object('id', v_test.id, 'slug', v_test.slug, 'status', v_test.status);
end;
$$;

create function private.issue_certificate_for_attestation(
  p_attestation_id uuid,
  p_actor_id uuid,
  p_source public.certificate_issue_source,
  p_supersedes uuid default null,
  p_batch_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attestation public.attestations%rowtype;
  v_revision public.test_revisions%rowtype;
  v_identity public.verified_identities%rowtype;
  v_certificate_id uuid;
  v_number text;
  v_user_id uuid;
begin
  select attestation.user_id into v_user_id
  from public.attestations attestation
  join public.account_controls control on control.user_id = attestation.user_id
  where attestation.id = p_attestation_id
    and control.status = 'active'
    and not control.deletion_pending;
  if v_user_id is null then
    raise exception using errcode = 'no_data_found', message = 'ATTESTATION_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attestation
  from public.attestations where id = p_attestation_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTESTATION_NOT_FOUND';
  end if;
  select * into v_revision from public.test_revisions where id = v_attestation.revision_id;
  if v_attestation.best_score < v_revision.pass_score then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'ATTESTATION_NOT_ELIGIBLE';
  end if;
  select * into v_identity
  from public.verified_identities
  where user_id = v_attestation.user_id
  for update;
  if v_identity.status <> 'verified' then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'IDENTITY_NOT_VERIFIED';
  end if;
  if exists (
    select 1 from public.certificates certificate
    where certificate.user_id = v_attestation.user_id
      and certificate.revision_id = v_attestation.revision_id
      and certificate.revoked_at is null
  ) then
    raise exception using errcode = 'unique_violation', message = 'ACTIVE_CERTIFICATE_EXISTS';
  end if;
  v_certificate_id := gen_random_uuid();
  v_number := 'SH-' || to_char(statement_timestamp(), 'YYYY') || '-'
    || upper(substr(replace(v_certificate_id::text, '-', ''), 1, 12));
  insert into public.certificates (
    id, certificate_number, user_id, revision_id, attestation_id, attempt_id,
    identity_version, full_name, job, organization, test_slug, test_title,
    score, total, pass_score, best_completed_at, issued_by, issue_source,
    supersedes_certificate_id
  ) values (
    v_certificate_id, v_number, v_attestation.user_id, v_revision.id,
    v_attestation.id, v_attestation.best_attempt_id, v_identity.version,
    concat_ws(' ', v_identity.name, v_identity.surname), v_identity.job,
    v_identity.organization, v_revision.slug, v_revision.title,
    v_attestation.best_score, v_revision.question_count, v_revision.pass_score,
    v_attestation.best_completed_at, p_actor_id, p_source, p_supersedes
  );
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, batch_id
  ) values (
    p_actor_id, v_attestation.user_id, 'certificate.issued', 'certificate',
    v_certificate_id::text,
    jsonb_build_object(
      'certificateNumber', v_number,
      'source', p_source,
      'score', v_attestation.best_score,
      'revisionId', v_revision.id
    ),
    p_batch_id
  );
  return v_certificate_id;
end;
$$;

create function private.attempt_payload(p_attempt_id uuid, p_retry_at timestamptz default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_key private.test_revision_answer_keys%rowtype;
  v_certificate public.certificates%rowtype;
  v_questions jsonb := '[]'::jsonb;
  v_review jsonb := '[]'::jsonb;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  select * into v_revision from public.test_revisions where id = v_attempt.revision_id;
  if v_attempt.status = 'passed' then
    select * into v_key
    from private.test_revision_answer_keys
    where revision_id = v_revision.id;
  end if;
  select * into v_certificate
  from public.certificates certificate
  where certificate.user_id = v_attempt.user_id
    and certificate.revision_id = v_attempt.revision_id
    and certificate.revoked_at is null
  limit 1;
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', question.value ->> 'id',
      'text', question.value ->> 'text',
      'position', question.ordinality,
      'selectedOptionId', case
        when v_attempt.status = 'started' and v_attempt.answers is not null
          then question.value -> 'options'
            -> v_attempt.answers[question.ordinality::integer] ->> 'id'
        else null
      end,
      'options', question.value -> 'options'
    ) order by question.ordinality), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'questionId', question.value ->> 'id',
      'selectedOptionId', question.value -> 'options'
        -> v_attempt.answers[question.ordinality::integer] ->> 'id',
      'correctOptionId', question.value -> 'options'
        -> v_key.correct_positions[question.ordinality::integer] ->> 'id',
      'isCorrect', v_attempt.answers[question.ordinality::integer]
        = v_key.correct_positions[question.ordinality::integer],
      'explanation', v_key.explanations[question.ordinality::integer]
    ) order by question.ordinality)
      filter (where v_attempt.status = 'passed'), '[]'::jsonb)
  into v_questions, v_review
  from jsonb_array_elements(v_revision.questions) with ordinality question(value, ordinality);
  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'testSlug', v_revision.slug,
    'title', v_revision.title,
    'status', v_attempt.status,
    'score', v_attempt.score,
    'total', v_revision.question_count,
    'passed', case
      when v_attempt.status = 'passed' then true
      when v_attempt.status = 'failed' then false
      else null
    end,
    'certificateId', v_certificate.id,
    'certificatePendingVerification',
      v_attempt.status = 'passed'
      and v_certificate.id is null
      and private.identity_state(v_attempt.user_id) <> 'verified',
    'durationMinutes', v_revision.duration_minutes,
    'expiresAt', v_attempt.expires_at,
    'serverNow', statement_timestamp(),
    'retryAt', p_retry_at,
    'questions', v_questions,
    'review', v_review
  );
end;
$$;

create function public.start_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_profile public.profiles%rowtype;
  v_revision public.test_revisions%rowtype;
  v_attempt public.test_attempts%rowtype;
  v_count integer;
  v_retry_at timestamptz;
begin
  if v_user_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  select profile.* into v_profile
  from public.profiles profile
  join public.account_controls control on control.user_id = profile.id
  where profile.id = v_user_id
    and control.status = 'active'
    and not control.deletion_pending
  for share of profile, control;
  if not found then
    raise exception using errcode = 'insufficient_privilege', message = 'ACCOUNT_UNAVAILABLE';
  end if;
  if v_profile.onboarding_completed_at is null
    or char_length(v_profile.name) = 0
    or char_length(v_profile.surname) = 0
    or char_length(v_profile.job) = 0
    or char_length(v_profile.organization) = 0 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'PROFILE_ONBOARDING_REQUIRED';
  end if;
  if v_profile.avatar_updated_at is null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
  end if;
  if not private.has_current_legal_acceptance(v_user_id) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;
  select revision.* into v_revision
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  where test.slug = p_test_slug and test.status = 'published'
  for share of test;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || v_revision.id::text, 0));
  update public.test_attempts
  set status = 'expired', completed_at = statement_timestamp()
  where user_id = v_user_id
    and revision_id = v_revision.id
    and status = 'started'
    and expires_at <= statement_timestamp();
  select * into v_attempt
  from public.test_attempts
  where user_id = v_user_id and revision_id = v_revision.id and status = 'started'
  order by started_at desc limit 1;
  if found then
    return private.attempt_payload(v_attempt.id);
  end if;
  select count(*), min(started_at) + interval '30 days'
  into v_count, v_retry_at
  from public.test_attempts
  where user_id = v_user_id
    and revision_id = v_revision.id
    and started_at > statement_timestamp() - interval '30 days';
  if v_count >= 6 then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_ROLLING_LIMIT',
      detail = jsonb_build_object('retryAt', v_retry_at)::text;
  end if;
  insert into public.test_attempts (user_id, revision_id, expires_at)
  values (
    v_user_id,
    v_revision.id,
    statement_timestamp() + make_interval(mins => v_revision.duration_minutes)
  ) returning * into v_attempt;
  return private.attempt_payload(v_attempt.id);
end;
$$;

create function public.resume_test_attempt(p_test_slug text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.start_test_attempt(p_test_slug);
$$;

create function public.get_test_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt
  from public.test_attempts
  where id = p_attempt_id and user_id = v_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status = 'started' and v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = statement_timestamp()
    where id = v_attempt.id and status = 'started' and expires_at <= statement_timestamp();
  end if;
  return private.attempt_payload(v_attempt.id);
end;
$$;

create function public.complete_test_attempt(p_attempt_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_key private.test_revision_answer_keys%rowtype;
  v_answers smallint[] := '{}'::smallint[];
  v_score integer := 0;
  v_matched_questions integer := 0;
  v_matched_options integer := 0;
  v_became_best boolean := false;
  v_attestation_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_batch_id uuid := gen_random_uuid();
begin
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_ANSWERS';
  end if;
  if jsonb_array_length(p_answers) > 100 or pg_column_size(p_answers) > 65536 then
    raise exception using errcode = 'program_limit_exceeded', message = 'ATTEMPT_ANSWERS_TOO_LARGE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attempt
  from public.test_attempts
  where id = p_attempt_id and user_id = v_user_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  if v_attempt.status in ('passed', 'failed') then
    return private.attempt_payload(v_attempt.id);
  end if;
  if v_attempt.status = 'expired' or v_attempt.expires_at <= statement_timestamp() then
    update public.test_attempts
    set status = 'expired', completed_at = coalesce(completed_at, statement_timestamp())
    where id = v_attempt.id;
    return private.attempt_payload(v_attempt.id);
  end if;
  select * into v_revision from public.test_revisions where id = v_attempt.revision_id;
  select * into v_key from private.test_revision_answer_keys where revision_id = v_revision.id;
  if jsonb_array_length(p_answers) <> v_revision.question_count
    or (select count(distinct item ->> 'questionId') from jsonb_array_elements(p_answers) item)
      <> v_revision.question_count then
    raise exception using errcode = 'check_violation', message = 'DUPLICATE_OR_MISSING_QUESTION_ANSWER';
  end if;
  with submitted as (
    select
      item ->> 'questionId' as question_id,
      item ->> 'optionId' as option_id
    from jsonb_array_elements(p_answers) item
  ), matched as (
    select
      question.ordinality::integer as question_position,
      submitted.question_id,
      option.ordinality::integer - 1 as option_position
    from jsonb_array_elements(v_revision.questions)
      with ordinality question(value, ordinality)
    left join submitted
      on submitted.question_id = question.value ->> 'id'
    left join lateral (
      select candidate.ordinality
      from jsonb_array_elements(question.value -> 'options')
        with ordinality candidate(value, ordinality)
      where candidate.value ->> 'id' = submitted.option_id
      limit 1
    ) option on true
  )
  select
    coalesce(array_agg(matched.option_position::smallint order by matched.question_position)
      filter (where matched.option_position is not null), '{}'::smallint[]),
    count(*) filter (
      where matched.option_position
        = v_key.correct_positions[matched.question_position]
    )::integer,
    count(matched.question_id)::integer,
    count(matched.option_position)::integer
  into v_answers, v_score, v_matched_questions, v_matched_options
  from matched;
  if v_matched_questions <> v_revision.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_QUESTION';
  end if;
  if v_matched_options <> v_revision.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_OPTION';
  end if;
  update public.test_attempts
  set answers = v_answers,
      score = v_score,
      status = case
        when v_score >= v_revision.pass_score then 'passed'::public.attempt_status
        else 'failed'::public.attempt_status
      end,
      completed_at = statement_timestamp()
  where id = v_attempt.id
  returning * into v_attempt;
  insert into public.attestations (
    user_id, revision_id, best_attempt_id, best_score, best_completed_at
  ) values (
    v_attempt.user_id, v_attempt.revision_id, v_attempt.id, v_attempt.score, v_attempt.completed_at
  )
  on conflict (user_id, revision_id) do update
  set best_attempt_id = excluded.best_attempt_id,
      best_score = excluded.best_score,
      best_completed_at = excluded.best_completed_at,
      updated_at = statement_timestamp()
  where excluded.best_score > public.attestations.best_score
     or (excluded.best_score = public.attestations.best_score
       and (excluded.best_completed_at, excluded.best_attempt_id)
         > (public.attestations.best_completed_at, public.attestations.best_attempt_id))
  returning id, best_attempt_id = v_attempt.id into v_attestation_id, v_became_best;
  if v_attestation_id is null then
    select id, best_attempt_id = v_attempt.id into v_attestation_id, v_became_best
    from public.attestations
    where user_id = v_attempt.user_id and revision_id = v_attempt.revision_id;
  end if;
  if v_became_best then
    select * into v_active_certificate
    from public.certificates certificate
    where certificate.user_id = v_attempt.user_id
      and certificate.revision_id = v_attempt.revision_id
      and certificate.revoked_at is null
    for update;
    if found and v_attempt.score > v_active_certificate.score then
      update public.certificates
      set revoked_at = statement_timestamp(),
          revoked_by = null,
          revoke_reason = 'Результат улучшен'
      where id = v_active_certificate.id;
      insert into public.admin_audit_log (
        actor_user_id, target_user_id, action, target_type, target_id,
        after_data, reason, batch_id
      ) values (
        null, v_attempt.user_id, 'certificate.revoked', 'certificate',
        v_active_certificate.id::text,
        jsonb_build_object('certificateNumber', v_active_certificate.certificate_number),
        'Результат улучшен', v_batch_id
      );
      perform private.issue_certificate_for_attestation(
        v_attestation_id, null, 'score_improvement', v_active_certificate.id, v_batch_id
      );
    end if;
  end if;
  return private.attempt_payload(v_attempt.id);
end;
$$;

create function private.certificate_state(p_attestation_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  with item as (
    select
      attestation.user_id,
      attestation.revision_id,
      attestation.best_score,
      revision.pass_score,
      private.identity_state(attestation.user_id) as identity_state
    from public.attestations attestation
    join public.test_revisions revision on revision.id = attestation.revision_id
    where attestation.id = p_attestation_id
  ), certificate as (
    select document.*
    from public.certificates document
    join item on item.user_id = document.user_id and item.revision_id = document.revision_id
    order by (document.revoked_at is null) desc, document.issued_at desc, document.id desc
    limit 1
  )
  select case
    when item.best_score < item.pass_score then 'not_eligible'
    when item.identity_state <> 'verified' then 'pending_identity'
    when certificate.id is null then 'ready'
    when certificate.revoked_at is null then 'issued'
    else 'revoked'
  end
  from item left join certificate on true;
$$;

create view private.admin_attestation_rows as
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
  order by
    certificate.user_id,
    certificate.revision_id,
    (certificate.revoked_at is null) desc,
    certificate.issued_at desc,
    certificate.id desc
) latest_certificate
  on latest_certificate.user_id = attestation.user_id
  and latest_certificate.revision_id = attestation.revision_id;

create function public.get_profile_attestations()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'attestationId', coalesce(attestation.id, revision.id),
    'testId', test.id,
    'testVersion', revision.version,
    'testSlug', revision.slug,
    'courseTitle', revision.title,
    'isCurrent', true,
    'score', attestation.best_score,
    'total', revision.question_count,
    'passScore', revision.pass_score,
    'completedAt', attestation.best_completed_at,
    'resultState', case
      when attestation.id is null then 'not_started'
      when attestation.best_score >= revision.pass_score then 'passed' else 'failed'
    end,
    'certificateState', case when attestation.id is null then 'not_eligible'
      else private.certificate_state(attestation.id) end,
    'certificateId', certificate.id,
    'certificateNumber', certificate.certificate_number,
    'certificateScore', certificate.score,
    'issuedAt', certificate.issued_at
  ) order by revision.title, revision.version desc), '[]'::jsonb)
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  left join public.attestations attestation
    on attestation.revision_id = revision.id
   and attestation.user_id = (select auth.uid())
  left join lateral (
    select document.*
    from public.certificates document
    where document.user_id = (select auth.uid())
      and document.revision_id = revision.id
    order by (document.revoked_at is null) desc, document.issued_at desc, document.id desc
    limit 1
  ) certificate on true
  where test.status = 'published';
$$;

create function public.get_profile_dashboard()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_profile public.profiles%rowtype;
  v_identity public.verified_identities%rowtype;
  v_attestations jsonb;
  v_acceptances jsonb;
begin
  select * into v_profile from public.profiles where id = v_user_id;
  if not found then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  select * into v_identity from public.verified_identities where user_id = v_user_id;
  v_attestations := public.get_profile_attestations();
  select coalesce(jsonb_agg(jsonb_build_object(
    'documentType', acceptance.document_type,
    'version', acceptance.version,
    'acceptedAt', acceptance.accepted_at,
    'source', acceptance.source
  ) order by acceptance.accepted_at desc), '[]'::jsonb)
  into v_acceptances
  from public.legal_acceptances acceptance
  where acceptance.user_id = v_user_id;
  return jsonb_build_object(
    'profile', jsonb_build_object(
      'id', v_profile.id,
      'name', v_profile.name,
      'surname', v_profile.surname,
      'job', v_profile.job,
      'organization', v_profile.organization,
      'avatarUpdatedAt', v_profile.avatar_updated_at,
      'onboardingCompletedAt', v_profile.onboarding_completed_at,
      'createdAt', v_profile.created_at,
      'updatedAt', v_profile.updated_at
    ),
    'approvedIdentity', case when v_identity.status = 'unverified' then null else jsonb_build_object(
      'version', v_identity.version,
      'name', v_identity.name,
      'surname', v_identity.surname,
      'job', v_identity.job,
      'organization', v_identity.organization,
      'verifiedAt', v_identity.verified_at,
      'verifiedBy', v_identity.verified_by
    ) end,
    'identityState', private.identity_state(v_user_id),
    'attestations', v_attestations,
    'legalAcceptances', v_acceptances
  );
end;
$$;

create function public.get_admin_attestation_filters()
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
        group by row.test_id
      ) item
    ), '[]'::jsonb)
  );
end;
$$;

create function public.list_admin_attestations_page(
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
        or row.organization_key like '%' || v_query || '%')
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
      (
        v_sort = 'name_asc' and (
          lower(row.surname) > v_cursor_first
          or (lower(row.surname) = v_cursor_first
            and lower(row.name) > v_cursor_second)
          or (lower(row.surname) = v_cursor_first
            and lower(row.name) = v_cursor_second
            and row.attestation_id < v_cursor_id)
        )
      )
      or (
        v_sort = 'organization_asc' and (
          row.organization_key > v_cursor_first
          or (row.organization_key = v_cursor_first
            and lower(row.surname) > v_cursor_second)
          or (row.organization_key = v_cursor_first
            and lower(row.surname) = v_cursor_second
            and lower(row.name) > v_cursor_third)
          or (row.organization_key = v_cursor_first
            and lower(row.surname) = v_cursor_second
            and lower(row.name) = v_cursor_third
            and row.attestation_id < v_cursor_id)
        )
      )
      or (
        v_sort = 'completed_asc' and (
          row.completed_at > v_cursor_time
          or (row.completed_at = v_cursor_time
            and row.attestation_id < v_cursor_id)
        )
      )
      or (
        v_sort = 'completed_desc' and (
          row.completed_at < v_cursor_time
          or (row.completed_at = v_cursor_time
            and row.attestation_id < v_cursor_id)
        )
      )
      or (
        v_sort = 'score_asc' and (
          row.score > v_cursor_score
          or (row.score = v_cursor_score
            and row.attestation_id < v_cursor_id)
        )
      )
      or (
        v_sort = 'score_desc' and (
          row.score < v_cursor_score
          or (row.score = v_cursor_score
            and row.attestation_id < v_cursor_id)
        )
      )
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
      'attestationId', page.attestation_id,
      'userId', page.user_id,
      'bestAttemptId', page.best_attempt_id,
      'testId', page.test_id,
      'revisionId', page.revision_id,
      'testVersion', page.test_version,
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
      'scoreImproved', page.score_improved
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
    (select jsonb_build_object('values',
        case
          when v_sort = 'name_asc' then
            jsonb_build_array(lower(last.surname), lower(last.name))
          when v_sort = 'organization_asc' then
            jsonb_build_array(last.organization_key, lower(last.surname), lower(last.name))
          when v_sort in ('completed_desc', 'completed_asc') then
            jsonb_build_array(last.completed_at::text)
          else jsonb_build_array(last.score)
        end,
        'id', last.attestation_id)
     from (select * from page order by
       case when v_sort = 'name_asc' then lower(surname) end desc,
       case when v_sort = 'name_asc' then lower(name) end desc,
       case when v_sort = 'organization_asc' then organization_key end desc,
       case when v_sort = 'organization_asc' then lower(surname) end desc,
       case when v_sort = 'organization_asc' then lower(name) end desc,
       case when v_sort = 'completed_asc' then completed_at end desc,
       case when v_sort = 'score_asc' then score end desc,
       case when v_sort = 'score_desc' then score end asc,
       case when v_sort = 'completed_desc' then completed_at end asc,
       attestation_id asc limit 1) last)
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

create function private.confirm_profile_identity(
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
  -- All result/identity/certificate operations for a user serialize on the
  -- same advisory key before taking row locks, preventing inverse lock order.
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
    where document.user_id = p_user_id and document.revoked_at is null
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

create function public.get_user_identity(p_target_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := coalesce(p_target_id, (select auth.uid()));
  v_identity public.verified_identities%rowtype;
begin
  if v_user_id is distinct from (select auth.uid()) then
    perform private.require_capability('identity.read');
  end if;
  select * into v_identity from public.verified_identities where user_id = v_user_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'userId', v_identity.user_id,
    'status', v_identity.status,
    'version', v_identity.version,
    'name', v_identity.name,
    'surname', v_identity.surname,
    'job', v_identity.job,
    'organization', v_identity.organization,
    'verifiedAt', v_identity.verified_at,
    'revokedAt', v_identity.revoked_at,
    'revokeReason', v_identity.revoke_reason
  );
end;
$$;

create function public.verify_user_identity(
  p_target_id uuid,
  p_name text,
  p_surname text,
  p_job text,
  p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
begin
  perform pg_advisory_xact_lock(hashtextextended(p_target_id::text, 0));
  update public.profiles
  set name = p_name, surname = p_surname, job = p_job, organization = p_organization
  where id = p_target_id;
  perform private.confirm_profile_identity(
    p_target_id, v_actor_id, gen_random_uuid(), 'identity.verified'
  );
  return public.get_user_identity(p_target_id);
end;
$$;

create function public.revoke_user_identity(p_target_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_reason text := private.normalize_profile_text(p_reason);
begin
  if char_length(v_reason) not between 3 and 500 then
    raise exception using errcode = 'check_violation', message = 'IDENTITY_REVOKE_REASON_INVALID';
  end if;
  update public.verified_identities
  set status = 'revoked', revoked_at = statement_timestamp(),
      revoked_by = v_actor_id, revoke_reason = v_reason
  where user_id = p_target_id and status = 'verified';
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'IDENTITY_NOT_VERIFIED';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, reason
  ) values (v_actor_id, p_target_id, 'identity.revoked', 'identity', p_target_id::text, v_reason);
  return public.get_user_identity(p_target_id);
end;
$$;

create function public.confirm_admin_identities(p_user_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_batch_id uuid := gen_random_uuid();
  v_user_id uuid;
  v_changed boolean;
  v_items jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_user_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  for v_user_id in select distinct unnest(p_user_ids) order by 1
  loop
    begin
      v_changed := private.confirm_profile_identity(
        v_user_id, v_actor_id, v_batch_id, 'identity.bulk_confirm'
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_user_id,
        'status', case when v_changed then 'completed' else 'already_completed' end,
        'reason', null
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_user_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

create function public.bulk_update_participants(
  p_user_ids uuid[],
  p_field text,
  p_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_batch_id uuid := gen_random_uuid();
  v_user_id uuid;
  v_value text := private.normalize_profile_text(p_value);
  v_before text;
  v_changed boolean;
  v_items jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_user_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  if p_field not in ('name', 'surname', 'job', 'organization') then
    raise exception using errcode = 'check_violation', message = 'PARTICIPANT_FIELD_INVALID';
  end if;
  if p_field in ('name', 'surname') and cardinality(p_user_ids) <> 1 then
    raise exception using errcode = 'check_violation', message = 'INDIVIDUAL_NAME_UPDATE_REQUIRED';
  end if;
  if char_length(v_value) < 1 or char_length(v_value) >
    (case when p_field in ('name', 'surname') then 80 else 160 end)
    or v_value ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation', message = 'PARTICIPANT_VALUE_INVALID';
  end if;
  for v_user_id in select distinct unnest(p_user_ids) order by 1
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
      select case p_field
        when 'name' then name when 'surname' then surname when 'job' then job else organization
      end into v_before
      from public.profiles where id = v_user_id for update;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
      end if;
      update public.profiles
      set name = case when p_field = 'name' then v_value else name end,
          surname = case when p_field = 'surname' then v_value else surname end,
          job = case when p_field = 'job' then v_value else job end,
          organization = case when p_field = 'organization' then v_value else organization end
      where id = v_user_id;
      v_changed := private.confirm_profile_identity(
        v_user_id, v_actor_id, v_batch_id, 'participant.bulk_update_confirm'
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_user_id,
        'status', case when v_before = v_value and not v_changed
          then 'already_completed' else 'completed' end,
        'reason', null
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_user_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

create function public.issue_certificates(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('certificate.issue');
  v_batch_id uuid := gen_random_uuid();
  v_attestation_id uuid;
  v_certificate_id uuid;
  v_items jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_attestation_ids), 0) not between 1 and 500 then
    raise exception using errcode = 'check_violation', message = 'BULK_SELECTION_INVALID';
  end if;
  for v_attestation_id in
    select requested.id from (select distinct unnest(p_attestation_ids) as id) requested
    left join public.attestations attestation on attestation.id = requested.id
    order by attestation.user_id nulls last, attestation.revision_id, requested.id
  loop
    begin
      if exists (
        select 1 from public.certificates certificate
        join public.attestations attestation on attestation.id = v_attestation_id
        where certificate.user_id = attestation.user_id
          and certificate.revision_id = attestation.revision_id
          and certificate.revoked_at is null
      ) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_attestation_id, 'status', 'already_completed', 'reason', null
        ));
        continue;
      end if;
      v_certificate_id := private.issue_certificate_for_attestation(
        v_attestation_id, v_actor_id, 'manual', null, v_batch_id
      );
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'completed', 'reason', null,
        'certificateId', v_certificate_id
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_attestation_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

create function public.revoke_certificates(p_certificate_ids uuid[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('certificate.revoke');
  v_batch_id uuid := gen_random_uuid();
  v_certificate_id uuid;
  v_reason text := private.normalize_profile_text(p_reason);
  v_items jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_certificate_ids), 0) not between 1 and 500
    or char_length(v_reason) not between 3 and 500 then
    raise exception using errcode = 'check_violation', message = 'CERTIFICATE_REVOKE_INVALID';
  end if;
  for v_certificate_id in select distinct unnest(p_certificate_ids) order by 1
  loop
    begin
      if not exists (select 1 from public.certificates where id = v_certificate_id) then
        raise exception using errcode = 'no_data_found', message = 'CERTIFICATE_NOT_FOUND';
      end if;
      if exists (select 1 from public.certificates where id = v_certificate_id and revoked_at is not null) then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'id', v_certificate_id, 'status', 'already_completed', 'reason', null
        ));
        continue;
      end if;
      update public.certificates
      set revoked_at = statement_timestamp(), revoked_by = v_actor_id, revoke_reason = v_reason
      where id = v_certificate_id;
      insert into public.admin_audit_log (
        actor_user_id, target_user_id, action, target_type, target_id,
        after_data, reason, batch_id
      ) select
        v_actor_id, certificate.user_id, 'certificate.revoked', 'certificate',
        certificate.id::text, jsonb_build_object('certificateNumber', certificate.certificate_number),
        v_reason, v_batch_id
      from public.certificates certificate where certificate.id = v_certificate_id;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_certificate_id, 'status', 'completed', 'reason', null
      ));
    exception when others then
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_certificate_id, 'status', 'skipped', 'reason', left(sqlerrm, 160)
      ));
    end;
  end loop;
  return v_items;
end;
$$;

create function public.revoke_certificate(p_certificate_id uuid, p_reason text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.revoke_certificates(array[p_certificate_id], p_reason) -> 0;
$$;

create function private.certificate_download_payload(p_certificate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', certificate.id,
    'certificateNumber', certificate.certificate_number,
    'userId', certificate.user_id,
    'revisionId', certificate.revision_id,
    'attestationId', certificate.attestation_id,
    'attemptId', certificate.attempt_id,
    'fullName', certificate.full_name,
    'job', certificate.job,
    'organization', certificate.organization,
    'testSlug', certificate.test_slug,
    'testTitle', certificate.test_title,
    'score', certificate.score,
    'total', certificate.total,
    'passScore', certificate.pass_score,
    'bestCompletedAt', certificate.best_completed_at,
    'issuedAt', certificate.issued_at,
    'templateVersion', certificate.template_version,
    'revokedAt', certificate.revoked_at,
    'revokeReason', certificate.revoke_reason
  )
  from public.certificates certificate
  where certificate.id = p_certificate_id;
$$;

create function public.get_certificate_download_payload(p_certificate_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_certificate public.certificates%rowtype;
begin
  select * into v_certificate from public.certificates where id = p_certificate_id;
  if not found then return null; end if;
  if v_certificate.user_id is distinct from v_user_id
    and not private.actor_has_capability(v_user_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege', message = 'CERTIFICATE_READ_FORBIDDEN';
  end if;
  if v_certificate.revoked_at is not null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'CERTIFICATE_REVOKED';
  end if;
  return private.certificate_download_payload(p_certificate_id);
end;
$$;

create function public.get_public_certificate(p_certificate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', certificate.id,
    'certificateNumber', certificate.certificate_number,
    'fullName', certificate.full_name,
    'organization', certificate.organization,
    'testTitle', certificate.test_title,
    'score', certificate.score,
    'total', certificate.total,
    'issuedAt', certificate.issued_at,
    'revokedAt', certificate.revoked_at,
    'revokeReason', certificate.revoke_reason
  )
  from public.certificates certificate
  where certificate.id = p_certificate_id;
$$;

create function public.resolve_certificate_export(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.export');
  v_requested integer;
  v_eligible integer;
  v_items jsonb;
  v_skipped jsonb;
  v_batch_id uuid := gen_random_uuid();
begin
  if not private.actor_has_capability(v_actor_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_REQUIRED';
  end if;
  v_requested := coalesce(cardinality(p_attestation_ids), 0);
  if v_requested > 500 then
    raise exception using errcode = 'program_limit_exceeded', message = 'EXPORT_SELECTION_TOO_LARGE';
  end if;
  with requested as (
    select distinct id from unnest(coalesce(p_attestation_ids, '{}'::uuid[])) id
  ), resolved as (
    select
      requested.id as requested_attestation_id,
      row.certificate_state,
      certificate.*
    from requested
    left join private.admin_attestation_rows row on row.attestation_id = requested.id
    left join public.certificates certificate on certificate.id = row.certificate_id
  )
  select
    count(*) filter (where resolved.certificate_state = 'issued' and resolved.id is not null),
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
  into v_eligible, v_items, v_skipped
  from resolved;
  if v_eligible > 100 then
    raise exception using errcode = 'program_limit_exceeded', message = 'EXPORT_CERTIFICATE_LIMIT';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_actor_id, 'certificate.exported', 'certificate_export', v_batch_id::text,
    jsonb_build_object('requested', v_requested, 'eligible', v_eligible), v_batch_id
  );
  return jsonb_build_object(
    'items', v_items,
    'skipped', v_skipped,
    'requested', v_requested,
    'total', v_requested,
    'eligible', v_eligible
  );
end;
$$;

create function public.get_site_settings()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'phoneE164', settings.phone_e164,
    'phoneDisplay', settings.phone_display,
    'whatsappE164', settings.whatsapp_e164,
    'whatsappSameAsPhone', settings.whatsapp_same_as_phone,
    'version', settings.version,
    'updatedAt', settings.updated_at,
    'updatedBy', case
      when private.actor_has_capability((select auth.uid()), 'site.settings.manage')
        then settings.updated_by
      else null
    end
  )
  from public.site_settings settings
  where settings.singleton;
$$;

create function public.update_site_settings(
  p_phone_e164 text,
  p_phone_display text,
  p_whatsapp_e164 text,
  p_whatsapp_same_as_phone boolean,
  p_expected_version bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('site.settings.manage');
  v_before public.site_settings%rowtype;
  v_after public.site_settings%rowtype;
begin
  select * into v_before from public.site_settings where singleton for update;
  if v_before.version is distinct from p_expected_version then
    raise exception using
      errcode = 'serialization_failure',
      message = 'SITE_SETTINGS_VERSION_CONFLICT',
      detail = v_before.version::text;
  end if;
  update public.site_settings
  set phone_e164 = btrim(p_phone_e164),
      phone_display = private.normalize_profile_text(p_phone_display),
      whatsapp_e164 = btrim(p_whatsapp_e164),
      whatsapp_same_as_phone = p_whatsapp_same_as_phone,
      version = version + 1,
      updated_at = statement_timestamp(),
      updated_by = v_actor_id
  where singleton
  returning * into v_after;
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, before_data, after_data
  ) values (
    v_actor_id, 'site.settings_updated', 'site_settings', 'contacts',
    jsonb_build_object(
      'phoneE164', v_before.phone_e164,
      'phoneDisplay', v_before.phone_display,
      'whatsappE164', v_before.whatsapp_e164,
      'whatsappSameAsPhone', v_before.whatsapp_same_as_phone,
      'version', v_before.version
    ),
    jsonb_build_object(
      'phoneE164', v_after.phone_e164,
      'phoneDisplay', v_after.phone_display,
      'whatsappE164', v_after.whatsapp_e164,
      'whatsappSameAsPhone', v_after.whatsapp_same_as_phone,
      'version', v_after.version
    )
  );
  return public.get_site_settings();
end;
$$;

create function private.quota_policy(p_action text)
returns table (quota integer, window_seconds integer)
language sql
immutable
set search_path = ''
as $$
  select
    case p_action
      when 'certificate.pdf' then 20
      when 'certificate.export' then 5
      when 'attempt.start' then 30
      when 'attempt.complete' then 30
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('site.settings.update', 'admin.access.mutate', 'admin.test.mutate') then 300
      when p_action like 'admin.%'
        and p_action not in (
          'admin.attestation.mutate', 'admin.identity.mutate', 'admin.certificate.revoke'
        ) then 300
      when p_action = 'certificate.export' then 300
      else 60
    end;
$$;

create function public.consume_business_quota(p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_quota integer;
  v_window integer;
  v_row private.business_rate_limits%rowtype;
  v_now timestamptz := statement_timestamp();
  v_retry integer;
begin
  if v_actor_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  select quota, window_seconds into v_quota, v_window from private.quota_policy(p_action);
  if v_quota is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'UNKNOWN_QUOTA_ACTION';
  end if;
  insert into private.business_rate_limits (actor_id, action, window_started_at, consumed)
  values (v_actor_id, p_action, v_now, 1)
  on conflict (actor_id, action) do update
  set window_started_at = case
        when private.business_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then v_now
        else private.business_rate_limits.window_started_at end,
      consumed = case
        when private.business_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then 1
        else private.business_rate_limits.consumed + 1 end
  returning * into v_row;
  if v_row.consumed > v_quota then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => v_window) - v_now
    )))::integer);
    return jsonb_build_object('allowed', false, 'retryAfter', v_retry);
  end if;
  return jsonb_build_object('allowed', true, 'retryAfter', 0);
end;
$$;

create function public.consume_coarse_ip_quota(p_action text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_quota integer;
  v_window integer;
  v_row private.coarse_ip_rate_limits%rowtype;
  v_now timestamptz := statement_timestamp();
  v_retry integer;
begin
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 128 then
    raise exception using errcode = 'check_violation', message = 'IP_HASH_INVALID';
  end if;
  select quota, window_seconds into v_quota, v_window from private.quota_policy(p_action);
  if v_quota is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'UNKNOWN_QUOTA_ACTION';
  end if;
  v_quota := v_quota * 3;
  insert into private.coarse_ip_rate_limits (ip_hash, action, window_started_at, consumed)
  values (p_ip_hash, p_action, v_now, 1)
  on conflict (ip_hash, action) do update
  set window_started_at = case
        when private.coarse_ip_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then v_now
        else private.coarse_ip_rate_limits.window_started_at end,
      consumed = case
        when private.coarse_ip_rate_limits.window_started_at
          <= v_now - make_interval(secs => v_window) then 1
        else private.coarse_ip_rate_limits.consumed + 1 end
  returning * into v_row;
  if v_row.consumed > v_quota then
    v_retry := greatest(1, ceil(extract(epoch from (
      v_row.window_started_at + make_interval(secs => v_window) - v_now
    )))::integer);
    return jsonb_build_object('allowed', false, 'retryAfter', v_retry);
  end if;
  return jsonb_build_object('allowed', true, 'retryAfter', 0);
end;
$$;

create function public.create_password_change_context(
  p_token_hash text,
  p_user_id uuid,
  p_context_kind text,
  p_session_id uuid,
  p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_token_hash !~ '^[0-9a-f]{64}$'
    or p_context_kind not in ('recovery', 'invite')
    or p_expires_at <= statement_timestamp()
    or p_expires_at > statement_timestamp() + interval '25 hours' then
    raise exception using errcode = 'check_violation', message = 'PASSWORD_CONTEXT_INVALID';
  end if;
  delete from private.password_change_contexts where expires_at <= statement_timestamp();
  insert into private.password_change_contexts (
    token_hash, user_id, purpose, session_id, expires_at
  ) values (p_token_hash, p_user_id, p_context_kind, p_session_id, p_expires_at);
end;
$$;

create function public.claim_password_change_context(
  p_token_hash text,
  p_context_kind text,
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.password_change_contexts
  set user_id = p_user_id, session_id = p_session_id
  where token_hash = p_token_hash
    and purpose = p_context_kind
    and expires_at > statement_timestamp()
    and consumed_at is null
    and (user_id is null or user_id = p_user_id)
    and (session_id is null or session_id = p_session_id);
  return found;
end;
$$;

create function public.inspect_password_change_context(
  p_token_hash text,
  p_user_id uuid,
  p_session_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select purpose
  from private.password_change_contexts
  where token_hash = p_token_hash
    and user_id = p_user_id
    and session_id = p_session_id
    and expires_at > statement_timestamp()
    and consumed_at is null;
$$;

create function public.consume_password_change_context(
  p_token_hash text,
  p_context_kind text,
  p_user_id uuid,
  p_session_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.password_change_contexts
  set consumed_at = statement_timestamp()
  where token_hash = p_token_hash
    and purpose = p_context_kind
    and user_id = p_user_id
    and session_id = p_session_id
    and expires_at > statement_timestamp()
    and consumed_at is null;
  return case when found then p_context_kind else null end;
end;
$$;

create function public.delete_password_change_context(p_token_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from private.password_change_contexts where token_hash = p_token_hash;
$$;

create function private.new_auth_admin_operation(
  p_operation_type text,
  p_actor_id uuid,
  p_target_id uuid,
  p_payload jsonb,
  p_correlation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid := gen_random_uuid();
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into private.auth_admin_outbox (
    id, operation_type, actor_user_id, target_id, payload,
    completion_token_hash, correlation_id
  ) values (
    v_id, p_operation_type, p_actor_id, p_target_id, p_payload,
    encode(extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'),
    coalesce(p_correlation_id, gen_random_uuid())
  );
  return jsonb_build_object('operationId', v_id, 'completionToken', v_token);
end;
$$;

create function public.prepare_user_invite(
  p_email text,
  p_name text,
  p_surname text,
  p_job text,
  p_requested_role public.app_role,
  p_password_ticket text,
  p_redirect_origin text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('user.invite');
  v_email text := lower(btrim(p_email));
begin
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$'
    or char_length(private.normalize_profile_text(p_name)) not between 1 and 80
    or char_length(private.normalize_profile_text(p_surname)) not between 1 and 80
    or char_length(private.normalize_profile_text(p_job)) not between 1 and 160
    or p_requested_role = 'superadmin'
    or char_length(p_password_ticket) not between 32 and 128 then
    raise exception using errcode = 'check_violation', message = 'INVITE_INVALID';
  end if;
  if p_requested_role = 'admin' and not exists (
    select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin'
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
  end if;
  return private.new_auth_admin_operation(
    'invite', v_actor_id, null,
    jsonb_build_object(
      'email', v_email,
      'name', private.normalize_profile_text(p_name),
      'surname', private.normalize_profile_text(p_surname),
      'job', private.normalize_profile_text(p_job),
      'requestedRole', p_requested_role,
      'passwordTicket', p_password_ticket,
      'redirectOrigin', p_redirect_origin,
      'inviteCorrelation', coalesce(p_correlation_id, gen_random_uuid())
    ),
    p_correlation_id
  );
end;
$$;

create function public.request_account_suspension_confirmed(
  p_target_id uuid,
  p_suspended boolean,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('user.suspend');
  v_reason text := private.normalize_profile_text(p_reason);
begin
  if p_target_id = v_actor_id or char_length(v_reason) not between 10 and 500 then
    raise exception using errcode = 'check_violation', message = 'SUSPENSION_INVALID';
  end if;
  if not exists (select 1 from public.profiles where id = p_target_id) then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  return private.new_auth_admin_operation(
    case when p_suspended then 'suspend' else 'restore' end,
    v_actor_id, p_target_id,
    jsonb_build_object('targetId', p_target_id, 'reason', v_reason),
    p_correlation_id
  );
end;
$$;

create function public.advance_auth_admin_operation(
  p_operation_id uuid,
  p_completion_token text,
  p_state text,
  p_external_target_id uuid default null,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_operation private.auth_admin_outbox%rowtype;
  v_expected text := encode(
    extensions.digest(convert_to(coalesce(p_completion_token, ''), 'utf8'), 'sha256'), 'hex'
  );
begin
  select * into v_operation
  from private.auth_admin_outbox where id = p_operation_id for update;
  if not found or v_operation.completion_token_hash <> v_expected then
    raise exception using errcode = 'insufficient_privilege', message = 'OUTBOX_TOKEN_INVALID';
  end if;
  if p_state not in ('external_succeeded', 'committed', 'retryable', 'rolled_back', 'failed') then
    raise exception using errcode = 'check_violation', message = 'OUTBOX_TRANSITION_INVALID';
  end if;
  if p_state = 'external_succeeded' then
    update private.auth_admin_outbox
    set state = p_state,
        target_id = coalesce(p_external_target_id, target_id),
        attempts = attempts + 1,
        last_error = null
    where id = p_operation_id;
  elsif p_state = 'committed' then
    if v_operation.operation_type = 'invite' then
      update public.profiles
      set name = v_operation.payload ->> 'name',
          surname = v_operation.payload ->> 'surname',
          job = v_operation.payload ->> 'job'
      where id = coalesce(p_external_target_id, v_operation.target_id);
      update public.user_roles
      set role = (v_operation.payload ->> 'requestedRole')::public.app_role,
          created_by = v_operation.actor_user_id
      where user_id = coalesce(p_external_target_id, v_operation.target_id);
    elsif v_operation.operation_type in ('suspend', 'restore') then
      update public.account_controls
      set status = case
            when v_operation.operation_type = 'suspend'
              then 'suspended'::public.account_status
            else 'active'::public.account_status
          end,
          suspended_at = case when v_operation.operation_type = 'suspend'
            then statement_timestamp() else null end,
          suspended_by = case when v_operation.operation_type = 'suspend'
            then v_operation.actor_user_id else null end,
          suspension_reason = case when v_operation.operation_type = 'suspend'
            then v_operation.payload ->> 'reason' else null end
      where user_id = coalesce(p_external_target_id, v_operation.target_id);
    end if;
    update private.auth_admin_outbox
    set state = 'committed', last_error = null
    where id = p_operation_id;
  else
    update private.auth_admin_outbox
    set state = p_state, attempts = attempts + 1, last_error = left(p_error, 500)
    where id = p_operation_id;
  end if;
  return jsonb_build_object('operationId', p_operation_id, 'state', p_state);
end;
$$;

create function public.claim_auth_admin_operation_confirmed(
  p_operation_id uuid,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('capability.manage');
  v_operation private.auth_admin_outbox%rowtype;
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  if not exists (
    select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin'
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
  end if;
  select * into v_operation
  from private.auth_admin_outbox
  where id = p_operation_id
    and state in ('prepared', 'external_succeeded', 'retryable')
  for update;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'OUTBOX_NOT_CLAIMABLE';
  end if;
  update private.auth_admin_outbox
  set completion_token_hash = encode(
    extensions.digest(convert_to(v_token, 'utf8'), 'sha256'), 'hex'
  ), attempts = attempts + 1
  where id = p_operation_id;
  return jsonb_build_object(
    'operationId', v_operation.id,
    'completionToken', v_token,
    'operationType', v_operation.operation_type,
    'state', v_operation.state,
    'externalTargetId', v_operation.target_id,
    'payload', v_operation.payload
  );
end;
$$;

create function private.capabilities_for_user(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(catalog.capability order by catalog.capability), '{}'::text[])
  from public.admin_capability_catalog catalog
  where private.actor_has_capability(p_user_id, catalog.capability);
$$;

create function public.manage_user_role_confirmed(
  p_target_id uuid,
  p_role public.app_role,
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('role.manage');
  v_old public.app_role;
  v_reason text := private.normalize_profile_text(p_reason);
begin
  if not exists (
    select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin'
  ) or p_target_id = v_actor_id or char_length(v_reason) not between 10 and 500 then
    raise exception using errcode = 'insufficient_privilege', message = 'ROLE_CHANGE_FORBIDDEN';
  end if;
  select role into v_old from public.user_roles where user_id = p_target_id for update;
  if not found then raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND'; end if;
  if v_old = 'superadmin' and p_role <> 'superadmin'
    and (select count(*) from public.user_roles where role = 'superadmin') <= 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'LAST_SUPERADMIN_PROTECTED';
  end if;
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles set role = p_role, created_by = v_actor_id where user_id = p_target_id;
  if p_role <> 'admin' then delete from public.user_capabilities where user_id = p_target_id; end if;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason, correlation_id, request_id, ip_hash, user_agent
  ) values (
    v_actor_id, p_target_id, 'role.changed', 'user', p_target_id::text,
    jsonb_build_object('role', v_old), jsonb_build_object('role', p_role),
    v_reason, coalesce(p_correlation_id, gen_random_uuid()), p_request_id, p_ip_hash,
    left(p_user_agent, 256)
  );
  return jsonb_build_object('userId', p_target_id, 'role', p_role);
end;
$$;

create function public.set_user_capabilities_confirmed(
  p_target_id uuid,
  p_capabilities text[],
  p_reason text,
  p_correlation_id uuid,
  p_request_id text default null,
  p_ip_hash text default null,
  p_user_agent text default null
)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('capability.manage');
  v_reason text := private.normalize_profile_text(p_reason);
  v_old text[];
  v_result text[];
begin
  if not exists (
    select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin'
  ) or char_length(v_reason) not between 10 and 500 then
    raise exception using errcode = 'insufficient_privilege', message = 'CAPABILITY_CHANGE_FORBIDDEN';
  end if;
  if not exists (
    select 1 from public.user_roles where user_id = p_target_id and role = 'admin'
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'TARGET_NOT_ADMIN';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_capabilities, '{}'::text[])) requested
    left join public.admin_capability_catalog catalog on catalog.capability = requested
    where catalog.capability is null
  ) then
    raise exception using errcode = 'check_violation', message = 'CAPABILITY_UNKNOWN';
  end if;
  v_old := private.capabilities_for_user(p_target_id);
  delete from public.user_capabilities where user_id = p_target_id;
  insert into public.user_capabilities (user_id, capability, granted_by)
  select p_target_id, requested, v_actor_id
  from (select distinct unnest(coalesce(p_capabilities, '{}'::text[])) requested) selected;
  v_result := private.capabilities_for_user(p_target_id);
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    before_data, after_data, reason, correlation_id, request_id, ip_hash, user_agent
  ) values (
    v_actor_id, p_target_id, 'capabilities.changed', 'user', p_target_id::text,
    jsonb_build_object('capabilities', v_old), jsonb_build_object('capabilities', v_result),
    v_reason, coalesce(p_correlation_id, gen_random_uuid()), p_request_id, p_ip_hash,
    left(p_user_agent, 256)
  );
  return v_result;
end;
$$;

create function public.bootstrap_superadmin(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.user_roles where role = 'superadmin') then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'SUPERADMIN_ALREADY_EXISTS';
  end if;
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles set role = 'superadmin', created_by = null where user_id = p_user_id;
  if not found then raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND'; end if;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, after_data
  ) values (null, p_user_id, 'superadmin.bootstrapped', 'user', p_user_id::text,
    jsonb_build_object('source', 'service_only'));
  return p_user_id;
end;
$$;

create function public.provision_admin_by_email(p_email text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  select auth_user.id into v_user_id
  from auth.users auth_user
  where lower(auth_user.email::text) = lower(btrim(p_email)) and auth_user.deleted_at is null
  order by auth_user.created_at limit 1 for update of auth_user;
  if v_user_id is null then raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND'; end if;
  perform set_config('safetyhub.skip_role_audit', '1', true);
  update public.user_roles set role = 'admin', created_by = null where user_id = v_user_id;
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id, after_data
  ) values (null, v_user_id, 'admin.provisioned_by_email', 'user', v_user_id::text,
    jsonb_build_object('source', 'service_only'));
  return v_user_id;
end;
$$;

create function public.begin_user_account_purge(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pending boolean;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'USER_ID_REQUIRED';
  end if;
  update public.account_controls
  set deletion_pending = true
  where user_id = p_target_id
  returning deletion_pending into v_pending;
  if not found then
    return jsonb_build_object('userId', p_target_id, 'exists', false, 'pending', true);
  end if;
  return jsonb_build_object('userId', p_target_id, 'exists', true, 'pending', v_pending);
end;
$$;

create function public.purge_user_account(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  -- Storage `{userId}/avatar.webp` must be removed by the service before this
  -- function; Storage objects are intentionally outside the Auth FK graph.
  delete from public.admin_audit_log
  where actor_user_id = p_target_id or target_user_id = p_target_id;
  delete from private.auth_admin_outbox
  where actor_user_id = p_target_id or target_id = p_target_id;
  delete from auth.users where id = p_target_id;
  v_deleted := found;
  return jsonb_build_object('deleted', v_deleted, 'userId', p_target_id);
end;
$$;

create function public.get_admin_data_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_actor_id uuid := private.require_any_capability(
  array['user.read','results.read','certificate.read','audit.read','test.manage']
);
begin
  return jsonb_build_object(
    'users', case when private.actor_has_capability(v_actor_id, 'user.read')
      then (select count(*) from public.profiles) else null end,
    'activeUsers', case when private.actor_has_capability(v_actor_id, 'user.read')
      then (select count(*) from public.account_controls where status = 'active') else null end,
    'suspendedUsers', case when private.actor_has_capability(v_actor_id, 'user.read')
      then (select count(*) from public.account_controls where status = 'suspended') else null end,
    'attempts', case when private.actor_has_capability(v_actor_id, 'results.read')
      then (select count(*) from public.attestations) else null end,
    'passedAttempts', case when private.actor_has_capability(v_actor_id, 'results.read')
      then (select count(*) from public.attestations attestation
        join public.test_revisions revision on revision.id = attestation.revision_id
        where attestation.best_score >= revision.pass_score) else null end,
    'activeCertificates', case when private.actor_has_capability(v_actor_id, 'certificate.read')
      then (select count(*) from public.certificates where revoked_at is null) else null end,
    'revokedCertificates', case when private.actor_has_capability(v_actor_id, 'certificate.read')
      then (select count(*) from public.certificates where revoked_at is not null) else null end,
    'auditEvents24h', case when private.actor_has_capability(v_actor_id, 'audit.read')
      then (select count(*) from public.admin_audit_log
        where created_at >= statement_timestamp() - interval '24 hours') else null end,
    'tests', case when private.actor_has_capability(v_actor_id, 'test.manage')
      then (select count(*) from public.tests) else null end,
    'generatedAt', statement_timestamp()
  );
end;
$$;

create function public.list_admin_users_page(
  p_limit integer default 25,
  p_query text default null,
  p_role public.app_role default null,
  p_status public.account_status default null,
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
  v_actor_id uuid := private.require_capability('user.read');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_query text := nullif(private.normalized_lookup_key(p_query), '');
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ADMIN_USERS_CURSOR';
  end if;
  with base_filtered as (
    select
      auth_user.id as id,
      auth_user.email::text as email,
      auth_user.email_confirmed_at is not null as email_confirmed,
      auth_user.last_sign_in_at,
      profile.name,
      profile.surname,
      profile.job,
      profile.organization,
      profile.avatar_updated_at,
      profile.onboarding_completed_at,
      profile.created_at,
      profile.updated_at,
      identity.status as identity_status,
      identity.version as identity_version,
      identity.name as identity_name,
      identity.surname as identity_surname,
      identity.job as identity_job,
      identity.organization as identity_organization,
      identity.verified_at,
      identity.revoked_at,
      identity.revoke_reason,
      role.role,
      control.status as account_status,
      private.capabilities_for_user(auth_user.id) as capabilities,
      (select count(*) from public.attestations where user_id = auth_user.id) as attestation_count,
      (select count(*) from public.certificates where user_id = auth_user.id) as certificate_count
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.verified_identities identity on identity.user_id = auth_user.id
    join public.user_roles role on role.user_id = auth_user.id
    join public.account_controls control on control.user_id = auth_user.id
    where auth_user.deleted_at is null
      and (v_query is null
        or lower(auth_user.email::text) like '%' || v_query || '%'
        or private.normalized_lookup_key(profile.name || ' ' || profile.surname)
          like '%' || v_query || '%')
      and (p_role is null or role.role = p_role)
      and (p_status is null or control.status = p_status)
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id) < (p_cursor_created_at, p_cursor_id)
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
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'email', page.email,
      'emailConfirmed', page.email_confirmed,
      'lastSignInAt', page.last_sign_in_at,
      'profile', jsonb_build_object(
        'id', page.id,
        'name', page.name,
        'surname', page.surname,
        'job', page.job,
        'organization', page.organization,
        'avatar_updated_at', page.avatar_updated_at,
        'onboarding_completed_at', page.onboarding_completed_at,
        'created_at', page.created_at,
        'updated_at', page.updated_at
      ),
      'identity', jsonb_build_object(
        'userId', page.id,
        'status', page.identity_status,
        'version', page.identity_version,
        'name', page.identity_name,
        'surname', page.identity_surname,
        'job', page.identity_job,
        'organization', page.identity_organization,
        'verifiedAt', page.verified_at,
        'revokedAt', page.revoked_at,
        'revokeReason', page.revoke_reason
      ),
      'role', page.role,
      'capabilities', page.capabilities,
      'status', page.account_status,
      'attempts', page.attestation_count,
      'certificates', page.certificate_count
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

create function public.list_admin_audit_page(
  p_limit integer default 25,
  p_actor text default null,
  p_target text default null,
  p_action text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_cursor_created_at timestamptz default null,
  p_cursor_id bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('audit.read');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ADMIN_AUDIT_CURSOR';
  end if;
  with expanded as (
    select audit.*,
      coalesce(nullif(concat_ws(' ', actor.name, actor.surname), ''),
        audit.actor_user_id::text, 'Система') as actor_label,
      coalesce(nullif(concat_ws(' ', target.name, target.surname), ''),
        audit.target_id, audit.target_type) as target_label
    from public.admin_audit_log audit
    left join public.profiles actor on actor.id = audit.actor_user_id
    left join public.profiles target on target.id = audit.target_user_id
  ), base_filtered as (
    select * from expanded
    where (p_actor is null or p_actor = '' or lower(actor_label) like '%' || lower(p_actor) || '%')
      and (p_target is null or p_target = '' or lower(target_label) like '%' || lower(p_target) || '%')
      and (p_action is null or p_action = '' or action like '%' || p_action || '%')
      and (p_from is null or created_at >= p_from)
      and (p_to is null or created_at < p_to)
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id) < (p_cursor_created_at, p_cursor_id)
  ), ordered as (
    select * from filtered order by created_at desc, id desc limit v_limit + 1
  ), page as (
    select * from ordered order by created_at desc, id desc limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id::text,
      'actorUserId', page.actor_user_id,
      'actorLabel', page.actor_label,
      'action', page.action,
      'targetType', page.target_type,
      'targetId', page.target_id,
      'targetLabel', page.target_label,
      'details', jsonb_strip_nulls(jsonb_build_object(
        'before', page.before_data,
        'after', page.after_data,
        'reason', page.reason,
        'batchId', page.batch_id
      )),
      'correlationId', page.correlation_id,
      'requestId', page.request_id,
      'userAgent', page.user_agent,
      'createdAt', page.created_at
    ) order by page.created_at desc, page.id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object('at', last.created_at, 'id', last.id::text)
      from page last order by last.created_at, last.id limit 1)
  into v_items, v_total, v_more, v_next
  from page;
  return jsonb_build_object('items', v_items, 'total', v_total,
    'hasMore', v_more, 'nextCursor', case when v_more then v_next else null end);
end;
$$;

create function public.list_admin_access_users_page(
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
  v_actor_id uuid := private.require_capability('capability.manage');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if not exists (select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin') then
    raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
  end if;
  if (p_cursor_created_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ADMIN_ACCESS_USERS_CURSOR';
  end if;
  with base_filtered as (
    select auth_user.id, auth_user.email::text as email, profile.created_at,
      concat_ws(' ', profile.name, profile.surname) as label,
      private.capabilities_for_user(auth_user.id) as capabilities
    from auth.users auth_user
    join public.profiles profile on profile.id = auth_user.id
    join public.user_roles role on role.user_id = auth_user.id
    where role.role in ('admin', 'superadmin') and auth_user.deleted_at is null
      and (p_query is null or p_query = ''
        or lower(auth_user.email::text) like '%' || lower(p_query) || '%'
        or private.normalized_lookup_key(profile.name || ' ' || profile.surname)
          like '%' || private.normalized_lookup_key(p_query) || '%')
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_created_at is null
      or (base_filtered.created_at, base_filtered.id) < (p_cursor_created_at, p_cursor_id)
  ), ordered as (
    select * from filtered order by created_at desc, id desc limit v_limit + 1
  ), page as (
    select * from ordered order by created_at desc, id desc limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id, 'email', page.email, 'label', page.label,
      'capabilities', page.capabilities
    ) order by page.created_at desc, page.id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object('at', last.created_at, 'id', last.id)
      from page last order by last.created_at, last.id limit 1)
  into v_items, v_total, v_more, v_next
  from page;
  return jsonb_build_object('items', v_items, 'total', v_total,
    'hasMore', v_more, 'nextCursor', case when v_more then v_next else null end);
end;
$$;

create function public.list_admin_access_outbox_page(
  p_limit integer default 25,
  p_operation_type text default null,
  p_state text default null,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('capability.manage');
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_items jsonb;
  v_total integer;
  v_more boolean;
  v_next jsonb;
begin
  if not exists (select 1 from public.user_roles where user_id = v_actor_id and role = 'superadmin') then
    raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
  end if;
  if (p_cursor_updated_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = 'invalid_parameter_value', message = 'INVALID_ADMIN_ACCESS_OUTBOX_CURSOR';
  end if;
  with base_filtered as (
    select outbox.*,
      coalesce(nullif(concat_ws(' ', actor.name, actor.surname), ''), outbox.actor_user_id::text) as actor_label,
      coalesce(nullif(concat_ws(' ', target.name, target.surname), ''),
        outbox.payload ->> 'email', outbox.target_id::text, '') as target_label
    from private.auth_admin_outbox outbox
    left join public.profiles actor on actor.id = outbox.actor_user_id
    left join public.profiles target on target.id = outbox.target_id
    where (p_operation_type is null or outbox.operation_type = p_operation_type)
      and (p_state is null or outbox.state = p_state)
  ), filtered as (
    select base_filtered.*
    from base_filtered
    where p_cursor_updated_at is null
      or (base_filtered.updated_at, base_filtered.id) < (p_cursor_updated_at, p_cursor_id)
  ), ordered as (
    select * from filtered order by updated_at desc, id desc limit v_limit + 1
  ), page as (
    select * from ordered order by updated_at desc, id desc limit v_limit
  )
  select
    coalesce(jsonb_agg(jsonb_build_object(
      'id', page.id,
      'operationType', page.operation_type,
      'state', page.state,
      'actorUserId', page.actor_user_id,
      'actorLabel', page.actor_label,
      'targetId', page.target_id,
      'targetLabel', page.target_label,
      'attempts', page.attempts,
      'lastError', page.last_error,
      'originalReason', page.payload ->> 'reason',
      'correlationId', page.correlation_id,
      'createdAt', page.created_at,
      'updatedAt', page.updated_at
    ) order by page.updated_at desc, page.id desc), '[]'::jsonb),
    (select count(*) from base_filtered),
    (select count(*) > v_limit from ordered),
    (select jsonb_build_object('at', last.updated_at, 'id', last.id)
      from page last order by last.updated_at, last.id limit 1)
  into v_items, v_total, v_more, v_next
  from page;
  return jsonb_build_object('items', v_items, 'total', v_total,
    'hasMore', v_more, 'nextCursor', case when v_more then v_next else null end);
end;
$$;

create function public.get_capacity_metrics()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'databaseBytes', pg_database_size(current_database()),
    'relations', jsonb_build_object(
      'profiles', jsonb_build_object(
        'bytes', pg_total_relation_size('public.profiles'::regclass),
        'rows', (select count(*) from public.profiles)
      ),
      'attempts', jsonb_build_object(
        'bytes', pg_total_relation_size('public.test_attempts'::regclass),
        'rows', (select count(*) from public.test_attempts)
      ),
      'attestations', jsonb_build_object(
        'bytes', pg_total_relation_size('public.attestations'::regclass),
        'rows', (select count(*) from public.attestations)
      ),
      'certificates', jsonb_build_object(
        'bytes', pg_total_relation_size('public.certificates'::regclass),
        'rows', (select count(*) from public.certificates)
      ),
      'audit', jsonb_build_object(
        'bytes', pg_total_relation_size('public.admin_audit_log'::regclass),
        'rows', (select count(*) from public.admin_audit_log)
      )
    ),
    'generatedAt', statement_timestamp()
  );
$$;

-- Storage is private and bounded. Browser users may read their own avatar but
-- uploads are routed through the same-origin server endpoint; only service_role
-- can write the canonical object and then mark avatar_updated_at.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-avatars', 'profile-avatars', false, 102400, array['image/webp']::text[])
on conflict (id) do update
set public = false,
    file_size_limit = 102400,
    allowed_mime_types = array['image/webp']::text[];

alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.account_controls enable row level security;
alter table public.admin_capability_catalog enable row level security;
alter table public.user_capabilities enable row level security;
alter table public.verified_identities enable row level security;
alter table public.articles enable row level security;
alter table public.article_slug_redirects enable row level security;
alter table public.tests enable row level security;
alter table public.test_revisions enable row level security;
alter table public.test_attempts enable row level security;
alter table public.attestations enable row level security;
alter table public.certificates enable row level security;
alter table public.legal_document_versions enable row level security;
alter table public.legal_acceptances enable row level security;
alter table public.site_settings enable row level security;
alter table public.admin_audit_log enable row level security;

create policy profiles_select_own on public.profiles
for select to authenticated using ((select auth.uid()) = id);
create policy roles_select_own on public.user_roles
for select to authenticated using ((select auth.uid()) = user_id);
create policy controls_select_own on public.account_controls
for select to authenticated using ((select auth.uid()) = user_id);
create policy capabilities_catalog_admin_read on public.admin_capability_catalog
for select to authenticated using (
  private.actor_has_any_capability((select auth.uid()), array['capability.manage','user.read'])
);
create policy user_capabilities_own_read on public.user_capabilities
for select to authenticated using ((select auth.uid()) = user_id);
create policy identity_select_own on public.verified_identities
for select to authenticated using ((select auth.uid()) = user_id);
create policy articles_public_read on public.articles
for select to anon, authenticated using (is_published and status = 'published');
create policy tests_public_read on public.tests
for select to anon, authenticated using (status = 'published');
create policy revisions_public_read on public.test_revisions
for select to anon, authenticated using (
  exists (select 1 from public.tests test
    where test.id = test_revisions.test_id
      and test.status = 'published'
      and test.current_revision_id = test_revisions.id)
);
create policy attempts_owner_read on public.test_attempts
for select to authenticated using ((select auth.uid()) = user_id);
create policy attestations_owner_read on public.attestations
for select to authenticated using ((select auth.uid()) = user_id);
create policy certificates_owner_read on public.certificates
for select to authenticated using (
  (select auth.uid()) = user_id
  or private.actor_has_capability((select auth.uid()), 'certificate.read')
);
create policy legal_versions_public_read on public.legal_document_versions
for select to anon, authenticated using (true);
create policy legal_acceptances_owner_read on public.legal_acceptances
for select to authenticated using ((select auth.uid()) = user_id);
create policy site_settings_public_read on public.site_settings
for select to anon, authenticated using (singleton);
create policy audit_capability_read on public.admin_audit_log
for select to authenticated using (
  private.actor_has_capability((select auth.uid()), 'audit.read')
);

create policy profile_avatars_select_own on storage.objects
for select to authenticated using (
  bucket_id = 'profile-avatars'
  and name = (select auth.uid())::text || '/avatar.webp'
);

revoke all on all tables in schema public from public, anon, authenticated;
grant select on public.articles, public.tests, public.test_revisions,
  public.legal_document_versions to anon, authenticated;
grant select on public.profiles, public.user_roles, public.account_controls,
  public.admin_capability_catalog, public.user_capabilities,
  public.verified_identities, public.test_attempts, public.attestations,
  public.certificates, public.legal_acceptances, public.admin_audit_log
  to authenticated;

revoke all on all tables in schema private from public, anon, authenticated, service_role;
revoke all on all functions in schema private from public, anon, authenticated, service_role;
-- Expression indexes on profiles evaluate these immutable normalizers during
-- trusted service-role maintenance writes. Browser roles retain no EXECUTE.
grant usage on schema private to service_role;
grant execute on function private.normalize_profile_text(text) to service_role;
grant execute on function private.normalized_lookup_key(text) to service_role;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Remove PostgreSQL's default EXECUTE privilege, then expose only reviewed RPCs.
revoke execute on all functions in schema public from public, anon, authenticated, service_role;

grant execute on function public.get_auth_context() to authenticated;
grant execute on function public.get_my_capabilities() to authenticated;
grant execute on function public.update_profile(text,text,text,text) to authenticated;
grant execute on function public.complete_profile_onboarding(text,text,text,text) to authenticated;
grant execute on function public.search_profile_organizations(text,integer) to authenticated;
grant execute on function public.accept_current_legal_documents(text,text,text,text) to authenticated;
grant execute on function public.get_user_identity(uuid) to authenticated;
grant execute on function public.verify_user_identity(uuid,text,text,text,text) to authenticated;
grant execute on function public.revoke_user_identity(uuid,text) to authenticated;
grant execute on function public.get_profile_attestations() to authenticated;
grant execute on function public.get_profile_dashboard() to authenticated;
grant execute on function public.start_test_attempt(text) to authenticated;
grant execute on function public.resume_test_attempt(text) to authenticated;
grant execute on function public.get_test_attempt(uuid) to authenticated;
grant execute on function public.complete_test_attempt(uuid,jsonb) to authenticated;
grant execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb) to authenticated;
grant execute on function public.set_article_status(uuid,public.article_status) to authenticated;
grant execute on function public.resolve_article_slug(text) to anon, authenticated;
grant execute on function public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  to authenticated;
grant execute on function public.get_test_editor_payload(uuid,uuid) to authenticated;
grant execute on function public.set_test_status(uuid,uuid,public.test_status) to authenticated;
grant execute on function public.confirm_admin_identities(uuid[]) to authenticated;
grant execute on function public.bulk_update_participants(uuid[],text,text) to authenticated;
grant execute on function public.issue_certificates(uuid[]) to authenticated;
grant execute on function public.revoke_certificates(uuid[],text) to authenticated;
grant execute on function public.revoke_certificate(uuid,text) to authenticated;
grant execute on function public.list_admin_attestations_page(
  integer,text,text,uuid,text,text,timestamptz,timestamptz,text,jsonb
) to authenticated;
grant execute on function public.get_admin_attestation_filters() to authenticated, service_role;
grant execute on function public.get_admin_data_summary() to authenticated;
grant execute on function public.list_admin_users_page(
  integer,text,public.app_role,public.account_status,timestamptz,uuid
) to authenticated;
grant execute on function public.list_admin_audit_page(
  integer,text,text,text,timestamptz,timestamptz,timestamptz,bigint
) to authenticated;
grant execute on function public.list_admin_access_users_page(integer,text,timestamptz,uuid)
  to authenticated;
grant execute on function public.list_admin_access_outbox_page(integer,text,text,timestamptz,uuid)
  to authenticated;
grant execute on function public.prepare_user_invite(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) to authenticated;
grant execute on function public.request_account_suspension_confirmed(
  uuid,boolean,text,uuid,text,text,text
) to authenticated;
grant execute on function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) to authenticated;
grant execute on function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) to authenticated;
grant execute on function public.claim_auth_admin_operation_confirmed(
  uuid,text,uuid,text,text,text
) to authenticated;
grant execute on function public.consume_business_quota(text) to authenticated;
grant execute on function public.get_certificate_download_payload(uuid) to authenticated;
grant execute on function public.resolve_certificate_export(uuid[]) to authenticated;
grant execute on function public.get_site_settings() to anon, authenticated, service_role;
grant execute on function public.update_site_settings(text,text,text,boolean,bigint) to authenticated;

-- These helpers require the server-held service role and are never callable
-- from an end-user session.
grant execute on function public.mark_signup_legal_acceptance(uuid,text,text) to service_role;
grant execute on function public.publish_legal_document_version(
  public.legal_document_type,text,text,timestamptz
) to service_role;
grant execute on function public.mark_profile_avatar_uploaded(uuid,timestamptz) to service_role;
grant execute on function public.get_public_certificate(uuid) to service_role;
grant execute on function public.consume_coarse_ip_quota(text,text) to service_role;
grant execute on function public.create_password_change_context(text,uuid,text,uuid,timestamptz) to service_role;
grant execute on function public.claim_password_change_context(text,text,uuid,uuid) to service_role;
grant execute on function public.inspect_password_change_context(text,uuid,uuid) to service_role;
grant execute on function public.consume_password_change_context(text,text,uuid,uuid) to service_role;
grant execute on function public.delete_password_change_context(text) to service_role;
grant execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text) to service_role;
grant execute on function public.bootstrap_superadmin(uuid) to service_role;
grant execute on function public.provision_admin_by_email(text) to service_role;
grant execute on function public.begin_user_account_purge(uuid) to service_role;
grant execute on function public.purge_user_account(uuid) to service_role;
grant execute on function public.get_capacity_metrics() to service_role;

comment on table public.test_attempts is
  'Compact one-row attempts: immutable revision reference, smallint[] final answers, no duplicated question text.';
comment on table public.attestations is
  'One server-maintained best result per user and immutable test revision.';
comment on table public.certificates is
  'Immutable certificate metadata snapshots only. PDF/ZIP bytes are generated on demand and never persisted.';
comment on function public.get_public_certificate(uuid) is
  'Service-only data lookup after the application has validated a versioned HMAC verification URL.';
comment on function public.purge_user_account(uuid) is
  'Service-only idempotent final database/Auth purge; remove the canonical Storage avatar first.';
comment on function public.begin_user_account_purge(uuid) is
  'Service-only idempotent gate: mark deletion pending before removing the canonical Storage avatar.';

create function public.resolve_admin_attestation_selection(
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
        or row.organization_key like '%' || v_query || '%')
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
        or row.organization_key like '%' || v_query || '%')
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
    'attestationIds', coalesce(jsonb_agg(attestation_id order by attestation_id), '[]'::jsonb),
    'userIds', coalesce(jsonb_agg(distinct user_id), '[]'::jsonb),
    'certificateIds', coalesce(jsonb_agg(distinct certificate_id)
      filter (where certificate_id is not null and certificate_state = 'issued'), '[]'::jsonb),
    'total', v_count,
    'uniquePeople', count(distinct user_id),
    'pendingIdentity', count(*) filter (where certificate_state = 'pending_identity'),
    'ready', count(*) filter (where certificate_state in ('ready', 'revoked')),
    'issued', count(*) filter (where certificate_state = 'issued'),
    'exportable', count(*) filter (where certificate_state = 'issued')
  ) into v_result from filtered;
  return v_result;
end;
$$;

-- This function is intentionally defined after the shared grant block because
-- it reuses the final attestation read model. Revoke PostgreSQL's default
-- EXECUTE privilege before exposing it to authenticated administrators.
revoke execute on function public.resolve_admin_attestation_selection(
  text,text,uuid,text,text,timestamptz,timestamptz,text
) from public, anon, authenticated, service_role;
grant execute on function public.resolve_admin_attestation_selection(
  text,text,uuid,text,text,timestamptz,timestamptz,text
) to authenticated;
