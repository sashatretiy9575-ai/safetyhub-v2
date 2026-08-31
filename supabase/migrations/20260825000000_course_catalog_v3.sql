-- Course catalogue v3: PDF presentations, three private assessment variants,
-- immutable attempt policy snapshots, calendar-day attempt limits and
-- administrative learning-history erasure. This is intentionally forward-only:
-- historical migrations remain the record of the previous catalogue.

insert into public.admin_capability_catalog
  (capability, category, label, admin_default, sensitive)
values
  ('results.delete', 'results', 'Удаление учебной истории', true, true)
on conflict (capability) do update
set category = excluded.category,
    label = excluded.label,
    admin_default = excluded.admin_default,
    sensitive = excluded.sensitive;

create type public.course_presentation_status as enum (
  'staging', 'validating', 'ready', 'rejected', 'retired'
);

create table public.course_presentations (
  id uuid primary key default gen_random_uuid(),
  course_id uuid references public.tests(id) on delete set null,
  storage_bucket text not null,
  storage_path text not null unique,
  thumbnail_path text,
  source_filename text not null,
  mime_type text not null default 'application/pdf',
  byte_size bigint not null,
  sha256 text not null,
  page_count integer not null,
  aspect_ratio text not null default '16:9',
  status public.course_presentation_status not null default 'staging',
  validation_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default statement_timestamp(),
  validated_at timestamptz,
  retired_at timestamptz,
  cleanup_claimed_at timestamptz,
  constraint course_presentation_bucket check (
    storage_bucket in ('course-presentations-staging', 'course-presentations')
  ),
  constraint course_presentation_storage_path_budget check (
    char_length(storage_path) between 1 and 1024 and storage_path !~ '[[:cntrl:]]'
  ),
  constraint course_presentation_thumbnail_path_budget check (
    thumbnail_path is null
    or (char_length(thumbnail_path) between 1 and 1024 and thumbnail_path !~ '[[:cntrl:]]')
  ),
  constraint course_presentation_filename_budget check (
    char_length(source_filename) between 1 and 255 and source_filename !~ '[[:cntrl:]]'
  ),
  constraint course_presentation_mime check (mime_type = 'application/pdf'),
  constraint course_presentation_size check (byte_size between 1 and 26214400),
  constraint course_presentation_hash_shape check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint course_presentation_page_count check (page_count between 1 and 200),
  constraint course_presentation_aspect_ratio check (aspect_ratio = '16:9'),
  constraint course_presentation_ready_immutable_path check (
    status <> 'ready'
    or (
      storage_path = course_id::text || '/' || id::text || '/' || sha256 || '.pdf'
      and thumbnail_path = course_id::text || '/' || id::text || '/'
        || sha256 || '-thumb.webp'
    )
  ),
  constraint course_presentation_error_budget check (
    validation_error is null or char_length(validation_error) between 1 and 500
  ),
  constraint course_presentation_state_shape check (
    (
      status in ('staging', 'validating')
      and storage_bucket = 'course-presentations-staging'
      and validated_at is null
      and retired_at is null
      and cleanup_claimed_at is null
    )
    or (
      status = 'ready'
      and course_id is not null
      and storage_bucket = 'course-presentations'
      and thumbnail_path is not null
      and validated_at is not null
      and retired_at is null
      and cleanup_claimed_at is null
      and validation_error is null
    )
    or (
      status = 'rejected'
      and validation_error is not null
      and validated_at is null
      and retired_at is null
      and cleanup_claimed_at is null
    )
    or (
      status = 'retired'
      and retired_at is not null
    )
  )
);

create index course_presentations_course_created_idx
  on public.course_presentations(course_id, created_at desc, id desc);
create index course_presentations_staging_cleanup_idx
  on public.course_presentations(cleanup_claimed_at, created_at, id)
  where status in ('staging', 'validating', 'rejected');
create index course_presentations_retired_cleanup_idx
  on public.course_presentations(cleanup_claimed_at, retired_at, id)
  where status = 'retired';
create unique index course_presentations_ready_hash_idx
  on public.course_presentations(course_id, sha256)
  where status = 'ready';

create function private.protect_course_presentation_object()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('ready', 'retired')
    and new.course_id is distinct from old.course_id
    and not (
      old.status = 'retired'
      and new.course_id is null
      and coalesce(current_setting('safetyhub.content_delete', true), '') = '1'
    ) then
    raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
  end if;
  if old.status in ('ready', 'retired') and (
    new.storage_bucket, new.storage_path, new.thumbnail_path,
    new.source_filename, new.mime_type, new.byte_size, new.sha256,
    new.page_count, new.aspect_ratio, new.created_by, new.created_at,
    new.validated_at
  ) is distinct from (
    old.storage_bucket, old.storage_path, old.thumbnail_path,
    old.source_filename, old.mime_type, old.byte_size, old.sha256,
    old.page_count, old.aspect_ratio, old.created_by, old.created_at,
    old.validated_at
  ) then
    raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
  end if;
  if old.status = 'ready' and new.status not in ('ready', 'retired') then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_IN_USE';
  end if;
  if old.status = 'retired' and new.status <> 'retired' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_IN_USE';
  end if;
  return new;
end;
$$;

create trigger course_presentations_protect_object
before update on public.course_presentations
for each row execute function private.protect_course_presentation_object();

revoke all on function private.protect_course_presentation_object()
  from public, anon, authenticated, service_role;

-- The existing administrative course-delete RPC already establishes the
-- narrowly scoped content-delete transaction flag. Retire every presentation
-- while its owning course still exists so the subsequent FK SET NULL cannot
-- violate the ready-state invariant and the Storage reconciler receives a
-- durable cleanup row instead of an orphaned object.
create function private.retire_course_presentations_before_course_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('safetyhub.content_delete', true), '') = '1' then
    update public.course_presentations presentation
    set status = 'retired',
        retired_at = coalesce(presentation.retired_at, statement_timestamp()),
        cleanup_claimed_at = null
    where presentation.course_id = old.id
      and presentation.status <> 'retired';
  end if;
  return old;
end;
$$;

create trigger tests_retire_presentations_before_delete
before delete on public.tests
for each row execute function private.retire_course_presentations_before_course_delete();

revoke all on function private.retire_course_presentations_before_course_delete()
  from public, anon, authenticated, service_role;

alter table public.tests
  add column display_order integer not null default 0,
  add column attempts_per_calendar_day integer not null default 8,
  add column attempt_reset_timezone text not null default 'Asia/Oral';

alter table public.tests
  add constraint tests_display_order_range check (display_order between 0 and 1000),
  add constraint tests_attempts_per_day_range
    check (attempts_per_calendar_day between 1 and 50),
  add constraint tests_attempt_reset_timezone
    check (attempt_reset_timezone = 'Asia/Oral');

with ordered as (
  select id, row_number() over (order by created_at, id)::integer as position
  from public.tests
)
update public.tests test
set display_order = ordered.position
from ordered
where ordered.id = test.id;

create unique index tests_published_display_order_unique
  on public.tests(display_order) where status = 'published';

alter table public.course_drafts
  drop constraint if exists course_draft_content_shape,
  drop constraint if exists course_draft_questions_shape;

alter table public.course_drafts
  add column display_order integer not null default 0,
  add column presentation_id uuid,
  add column attempts_per_calendar_day integer not null default 8,
  add column attempt_reset_timezone text not null default 'Asia/Oral',
  add column question_variants jsonb not null default '[]'::jsonb,
  add constraint course_draft_presentation_id_fkey
    foreign key (presentation_id) references public.course_presentations(id) on delete restrict,
  add constraint course_draft_display_order_range check (display_order between 0 and 1000),
  add constraint course_draft_attempts_per_day_range
    check (attempts_per_calendar_day between 1 and 50),
  add constraint course_draft_attempt_reset_timezone
    check (attempt_reset_timezone = 'Asia/Oral'),
  add constraint course_draft_content_shape check (
    jsonb_typeof(content) = 'object'
    and jsonb_typeof(content -> 'modules') = 'array'
    and jsonb_array_length(content -> 'modules') between 0 and 50
    and pg_column_size(content) <= 524288
  ),
  add constraint course_draft_questions_shape check (
    jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) <= 100
    and pg_column_size(questions) <= 262144
  ),
  add constraint course_draft_question_variants_budget check (
    jsonb_typeof(question_variants) = 'array'
    and jsonb_array_length(question_variants) <= 3
    and pg_column_size(question_variants) <= 1048576
  );

update public.course_drafts draft
set display_order = test.display_order
from public.tests test
where test.id = draft.test_id;

alter table public.test_revisions
  add column display_order integer not null default 0,
  add column presentation_id uuid,
  add column attempts_per_calendar_day integer not null default 8,
  add column attempt_reset_timezone text not null default 'Asia/Oral',
  add constraint test_revisions_presentation_id_fkey
    foreign key (presentation_id) references public.course_presentations(id) on delete restrict,
  add constraint revision_display_order_range check (display_order between 0 and 1000),
  add constraint revision_attempts_per_day_range
    check (attempts_per_calendar_day between 1 and 50),
  add constraint revision_attempt_reset_timezone
    check (attempt_reset_timezone = 'Asia/Oral');

create unique index test_revisions_test_id_id_unique
  on public.test_revisions(test_id, id);

create table public.test_revision_variants (
  id uuid primary key default gen_random_uuid(),
  stable_id uuid,
  revision_id uuid not null references public.test_revisions(id) on delete cascade,
  variant_number smallint not null,
  questions jsonb not null,
  question_count smallint not null default 10,
  created_at timestamptz not null default statement_timestamp(),
  unique (revision_id, variant_number),
  unique (revision_id, id),
  constraint test_revision_variant_number check (variant_number between 1 and 3),
  constraint test_revision_variant_question_count check (question_count between 1 and 100),
  constraint test_revision_variant_questions_shape check (
    jsonb_typeof(questions) = 'array'
    and jsonb_array_length(questions) = question_count
    and pg_column_size(questions) <= 524288
  )
);

create table private.test_revision_variant_answer_keys (
  variant_id uuid primary key,
  revision_id uuid not null,
  correct_option_ids jsonb not null,
  explanations jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default statement_timestamp(),
  constraint test_revision_variant_answer_keys_fk
    foreign key (revision_id, variant_id)
    references public.test_revision_variants(revision_id, id) on delete cascade,
  constraint test_revision_variant_correct_ids_shape check (
    jsonb_typeof(correct_option_ids) = 'array'
    and jsonb_array_length(correct_option_ids) between 1 and 100
  ),
  constraint test_revision_variant_explanations_shape check (
    jsonb_typeof(explanations) = 'array'
    and jsonb_array_length(explanations) = jsonb_array_length(correct_option_ids)
  )
);

-- Every legacy revision receives a compatibility variant. This keeps the old
-- catalogue usable during a rolling deployment while v3 publication enforces
-- the strict three-by-ten contract.
insert into public.test_revision_variants (
  revision_id, variant_number, questions, question_count
)
select revision.id, 1, revision.questions, revision.question_count
from public.test_revisions revision
where not exists (
  select 1 from public.test_revision_variants variant
  where variant.revision_id = revision.id
);

insert into private.test_revision_variant_answer_keys (
  variant_id, revision_id, correct_option_ids, explanations
)
select
  variant.id,
  revision.id,
  coalesce((
    select jsonb_agg(
      to_jsonb(question.value -> 'options'
        -> answer_key.correct_positions[question.ordinality::integer] ->> 'id')
      order by question.ordinality
    )
    from jsonb_array_elements(revision.questions)
      with ordinality question(value, ordinality)
  ), '[]'::jsonb),
  to_jsonb(answer_key.explanations)
from public.test_revisions revision
join public.test_revision_variants variant
  on variant.revision_id = revision.id and variant.variant_number = 1
join private.test_revision_answer_keys answer_key
  on answer_key.revision_id = revision.id
on conflict (variant_id) do nothing;

-- Legacy revisions had no product-level variant identifier. Their generated
-- row identifier becomes the stable identifier for deterministic export.
update public.test_revision_variants
set stable_id = id
where stable_id is null;
alter table public.test_revision_variants
  alter column stable_id set not null,
  add constraint test_revision_variants_stable_id_unique
    unique (revision_id, stable_id);

alter table public.test_attempts
  add column test_id uuid,
  add column variant_id uuid,
  add column duration_minutes integer,
  add column pass_score integer,
  add column attempts_per_day integer,
  add column reset_timezone text;

update public.test_attempts attempt
set test_id = revision.test_id,
    variant_id = variant.id,
    duration_minutes = revision.duration_minutes,
    pass_score = revision.pass_score,
    attempts_per_day = revision.attempts_per_calendar_day,
    reset_timezone = revision.attempt_reset_timezone
from public.test_revisions revision
join public.test_revision_variants variant
  on variant.revision_id = revision.id and variant.variant_number = 1
where revision.id = attempt.revision_id;

alter table public.test_attempts
  alter column test_id set not null,
  alter column variant_id set not null,
  alter column duration_minutes set not null,
  alter column pass_score set not null,
  alter column attempts_per_day set not null,
  alter column reset_timezone set not null,
  alter column attempts_per_day set default 8,
  alter column reset_timezone set default 'Asia/Oral',
  add constraint test_attempts_test_revision_fk
    foreign key (test_id, revision_id)
    references public.test_revisions(test_id, id) on delete cascade,
  add constraint test_attempts_revision_variant_fk
    foreign key (revision_id, variant_id)
    references public.test_revision_variants(revision_id, id) on delete cascade,
  add constraint test_attempt_duration_range check (duration_minutes between 1 and 120),
  add constraint test_attempt_pass_score_range check (pass_score between 1 and 100),
  add constraint test_attempt_attempts_per_day_range check (attempts_per_day between 1 and 50),
  add constraint test_attempt_reset_timezone check (reset_timezone = 'Asia/Oral');

-- Normalize the unlikely rolling-deploy edge case where a participant has one
-- started attempt in multiple revisions of the same course, then enforce the
-- intended one-active-attempt-per-course invariant.
with ranked as (
  select id,
    row_number() over (
      partition by user_id, test_id order by started_at desc, id desc
    ) as active_rank
  from public.test_attempts
  where status = 'started'
)
update public.test_attempts attempt
set status = 'expired', completed_at = statement_timestamp()
from ranked
where ranked.id = attempt.id and ranked.active_rank > 1;

drop index if exists public.test_attempts_one_started_idx;
drop index if exists public.test_attempts_rolling_limit_idx;
create unique index test_attempts_one_started_course_idx
  on public.test_attempts(user_id, test_id) where status = 'started';
create index test_attempts_calendar_limit_idx
  on public.test_attempts(user_id, test_id, started_at desc);

create function private.validate_test_attempt_v3()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
begin
  select * into v_revision
  from public.test_revisions revision where revision.id = new.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = new.variant_id and variant.revision_id = new.revision_id;
  if v_revision.id is null or v_variant.id is null
    or new.test_id is distinct from v_revision.test_id
    or new.duration_minutes is distinct from v_revision.duration_minutes
    or new.pass_score is distinct from v_revision.pass_score
    or new.attempts_per_day is distinct from v_revision.attempts_per_calendar_day
    or new.reset_timezone is distinct from v_revision.attempt_reset_timezone
    or new.expires_at is distinct from
      new.started_at + make_interval(mins => new.duration_minutes) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  if TG_OP = 'UPDATE' and (
    new.user_id is distinct from old.user_id
    or new.test_id is distinct from old.test_id
    or new.revision_id is distinct from old.revision_id
    or new.variant_id is distinct from old.variant_id
    or new.duration_minutes is distinct from old.duration_minutes
    or new.pass_score is distinct from old.pass_score
    or new.attempts_per_day is distinct from old.attempts_per_day
    or new.reset_timezone is distinct from old.reset_timezone
    or new.started_at is distinct from old.started_at
    or new.expires_at is distinct from old.expires_at
  ) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'ATTEMPT_IMMUTABLE';
  end if;

  if new.status in ('passed', 'failed') and (
    cardinality(new.answers) is distinct from v_variant.question_count
    or new.score not between 0 and v_variant.question_count
    or exists (select 1 from unnest(new.answers) answer where answer not between 0 and 3)
    or (new.status = 'passed' and new.score < new.pass_score)
    or (new.status = 'failed' and new.score >= new.pass_score)
  ) then
    raise exception using errcode = 'check_violation',
      message = 'INVALID_ATTEMPT_ANSWERS';
  end if;
  return new;
end;
$$;

create trigger test_attempts_validate_v3
before insert or update on public.test_attempts
for each row execute function private.validate_test_attempt_v3();

revoke all on function private.validate_test_attempt_v3()
  from public, anon, authenticated, service_role;

create table private.learning_history_delete_receipts (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  idempotency_key uuid not null,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null default statement_timestamp() + interval '24 hours',
  primary key (actor_user_id, idempotency_key),
  constraint learning_history_receipt_hash_shape check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint learning_history_receipt_expiry check (expires_at > created_at)
);

create index learning_history_delete_receipts_expiry_idx
  on private.learning_history_delete_receipts(expires_at);

create table public.course_catalog_batches (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'staging',
  created_by uuid references auth.users(id) on delete set null,
  activation_idempotency_key uuid,
  result jsonb,
  created_at timestamptz not null default statement_timestamp(),
  activated_at timestamptz,
  constraint course_catalog_batch_status check (status in ('staging', 'activated', 'cancelled')),
  constraint course_catalog_batch_state check (
    (status = 'staging' and activated_at is null and result is null)
    or (status = 'activated' and activated_at is not null
      and activation_idempotency_key is not null and result is not null)
    or (status = 'cancelled' and activated_at is null)
  )
);

create table public.course_catalog_batch_items (
  batch_id uuid not null references public.course_catalog_batches(id) on delete cascade,
  test_id uuid not null references public.tests(id) on delete cascade,
  display_order integer not null,
  expected_content_hash text not null,
  primary key (batch_id, test_id),
  unique (batch_id, display_order),
  constraint course_catalog_batch_item_order check (display_order between 1 and 5),
  constraint course_catalog_batch_item_hash check (expected_content_hash ~ '^[0-9a-f]{64}$')
);

create table private.course_catalog_runtime_state (
  singleton boolean primary key default true check (singleton),
  maintenance_enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default statement_timestamp()
);

insert into private.course_catalog_runtime_state(singleton, maintenance_enabled)
values (true, false);

revoke all on private.course_catalog_runtime_state
  from public, anon, authenticated, service_role;

create function private.course_catalog_maintenance_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select state.maintenance_enabled
    from private.course_catalog_runtime_state state
    where state.singleton
  ), true);
$$;

-- Every course-content DML path, including legacy v2 and direct service-role
-- writes, participates in the same lock as maintenance transitions. Catalogue
-- activation is the sole course mutation intentionally allowed while enabled.
create function private.guard_course_catalog_maintenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if private.course_catalog_maintenance_enabled()
    and coalesce(current_setting('safetyhub.catalog_activation', true), '') <> '1' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CATALOG_MAINTENANCE';
  end if;
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger tests_course_catalog_maintenance
before insert or update or delete on public.tests
for each row execute function private.guard_course_catalog_maintenance();
create trigger course_drafts_course_catalog_maintenance
before insert or update or delete on public.course_drafts
for each row execute function private.guard_course_catalog_maintenance();
create trigger test_revisions_course_catalog_maintenance
before insert or update or delete on public.test_revisions
for each row execute function private.guard_course_catalog_maintenance();
create trigger test_revision_variants_course_catalog_maintenance
before insert or update or delete on public.test_revision_variants
for each row execute function private.guard_course_catalog_maintenance();
create trigger test_revision_variant_keys_course_catalog_maintenance
before insert or update or delete on private.test_revision_variant_answer_keys
for each row execute function private.guard_course_catalog_maintenance();
create trigger legacy_test_revision_keys_course_catalog_maintenance
before insert or update or delete on private.test_revision_answer_keys
for each row execute function private.guard_course_catalog_maintenance();
create trigger course_catalog_batches_maintenance
before insert or update or delete on public.course_catalog_batches
for each row execute function private.guard_course_catalog_maintenance();
create trigger course_catalog_batch_items_maintenance
before insert or update or delete on public.course_catalog_batch_items
for each row execute function private.guard_course_catalog_maintenance();

create function private.guard_course_presentation_maintenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if private.course_catalog_maintenance_enabled()
    and coalesce(current_setting('safetyhub.catalog_activation', true), '') <> '1'
    and coalesce(current_setting('safetyhub.presentation_cleanup', true), '') <> '1' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CATALOG_MAINTENANCE';
  end if;
  if TG_OP = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger course_presentations_maintenance
before insert or update or delete on public.course_presentations
for each row execute function private.guard_course_presentation_maintenance();

revoke all on function private.course_catalog_maintenance_enabled(),
  private.guard_course_catalog_maintenance(),
  private.guard_course_presentation_maintenance()
from public, anon, authenticated, service_role;

alter table public.course_presentations enable row level security;
alter table public.test_revision_variants enable row level security;
alter table public.course_catalog_batches enable row level security;
alter table public.course_catalog_batch_items enable row level security;

create policy course_presentations_public_read on public.course_presentations
for select to anon, authenticated using (
  status = 'ready'
  and exists (
    select 1
    from public.tests test
    join public.test_revisions revision on revision.id = test.current_revision_id
    where test.id = course_presentations.course_id
      and test.status = 'published'
      and revision.presentation_id = course_presentations.id
  )
);

revoke all on public.course_presentations, public.test_revision_variants,
  public.course_catalog_batches, public.course_catalog_batch_items
from public, anon, authenticated;
grant all on public.course_presentations, public.test_revision_variants,
  public.course_catalog_batches, public.course_catalog_batch_items
to service_role;

grant select (
  id, course_id, storage_bucket, storage_path, thumbnail_path, byte_size,
  sha256, page_count, aspect_ratio, status, validated_at
) on public.course_presentations to anon, authenticated;

-- No browser role receives table access to the variant bank or its private
-- answer keys. A learner sees only the randomly assigned variant via RPC.
revoke all on private.test_revision_variant_answer_keys,
  private.learning_history_delete_receipts
from public, anon, authenticated, service_role;

-- A column-level REVOKE does not override the baseline table-level SELECT.
-- Replace those broad grants with explicit public projections so neither the
-- v3 answer-bearing draft_content nor the legacy first-variant question bank
-- can be selected directly by a browser role.
revoke select on public.tests, public.test_revisions from anon, authenticated;
grant select (
  id, current_revision_id, status
) on public.tests to anon, authenticated;
grant select (
  id, test_id, version, slug, title, description, icon, display_order,
  presentation_id, content, seo, jurisdiction, effective_date, sources,
  question_count, duration_minutes, pass_score, attempts_per_calendar_day,
  attempt_reset_timezone, published_at
) on public.test_revisions to anon, authenticated;

revoke select on public.test_attempts from authenticated;
grant select (
  id, user_id, revision_id, status, answers, score,
  started_at, expires_at, completed_at
) on public.test_attempts to authenticated;

drop policy if exists course_presentations_staging_admin_insert on storage.objects;
-- Deliberately do not add an authenticated INSERT policy. Browser uploads use
-- a short-lived Storage signed-upload token scoped by the service-role route to
-- one exact staging object; an ordinary user JWT must not be an upload grant.

drop policy if exists course_presentations_staging_admin_read on storage.objects;
create policy course_presentations_staging_admin_read on storage.objects
for select to authenticated using (
  bucket_id = 'course-presentations-staging'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and private.actor_has_capability((select auth.uid()), 'test.manage')
);

drop policy if exists course_presentations_staging_admin_delete on storage.objects;
create policy course_presentations_staging_admin_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'course-presentations-staging'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and private.actor_has_capability((select auth.uid()), 'test.manage')
);

comment on table public.course_presentations is
  'Metadata only. PDF/WebP bytes live in immutable Supabase Storage objects.';
comment on table public.test_revision_variants is
  'Immutable public question projections. Browser roles have no direct SELECT.';
comment on table private.test_revision_variant_answer_keys is
  'Private correct option IDs and optional explanations for one immutable variant.';
comment on column public.tests.display_order is
  'Course catalogue order. v3 catalogue activation requires the exact positions 1..5.';
comment on column public.test_attempts.variant_id is
  'Server-selected immutable variant; deliberately omitted from learner RPC payloads and grants.';

-- Storage bytes cannot be removed transactionally from PostgreSQL.  A trusted
-- reconciler leases stale staging or retired metadata here, deletes the returned objects
-- with the Storage Admin API, and acknowledges only successful deletions with
-- complete_course_presentation_cleanup.  Retired staging rows are re-leased
-- after a short timeout if a worker dies between those two operations.
create function public.claim_stale_course_presentations(
  p_limit integer default 50,
  p_ttl_hours integer default 24,
  p_lease_minutes integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_ttl_hours integer := least(greatest(coalesce(p_ttl_hours, 24), 1), 720);
  v_lease_minutes integer := least(greatest(coalesce(p_lease_minutes, 10), 1), 60);
  v_claimed_at timestamptz := statement_timestamp();
  v_items jsonb;
begin
  perform set_config('safetyhub.presentation_cleanup', '1', true);
  with candidates as (
    select presentation.id
    from public.course_presentations presentation
    where (
        (
          presentation.cleanup_claimed_at is null
          and (
            (
              presentation.status in ('staging', 'validating', 'rejected')
              and presentation.storage_bucket = 'course-presentations-staging'
              and presentation.created_at
                < v_claimed_at - make_interval(hours => v_ttl_hours)
            )
            or (
              presentation.status = 'retired'
              and presentation.retired_at
                < v_claimed_at - make_interval(hours => v_ttl_hours)
            )
          )
        )
        or (
          presentation.status = 'retired'
          and presentation.cleanup_claimed_at
            < v_claimed_at - make_interval(mins => v_lease_minutes)
        )
      )
      and not exists (
        select 1 from public.course_drafts draft
        where draft.presentation_id = presentation.id
      )
      and not exists (
        select 1 from public.test_revisions revision
        where revision.presentation_id = presentation.id
      )
    order by coalesce(presentation.retired_at, presentation.created_at), presentation.id
    limit v_limit
    for update skip locked
  ), claimed as (
    update public.course_presentations presentation
    set status = 'retired',
        retired_at = coalesce(presentation.retired_at, v_claimed_at),
        cleanup_claimed_at = v_claimed_at
    from candidates
    where presentation.id = candidates.id
    returning presentation.id, presentation.storage_bucket,
      presentation.storage_path, presentation.thumbnail_path,
      presentation.sha256, presentation.byte_size
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', claimed.id,
    'bucket', claimed.storage_bucket,
    'path', claimed.storage_path,
    'thumbnailPath', claimed.thumbnail_path,
    'sha256', claimed.sha256,
    'byteSize', claimed.byte_size
  ) order by claimed.id), '[]'::jsonb)
  into v_items
  from claimed;

  return jsonb_build_object(
    'items', v_items,
    'count', jsonb_array_length(v_items),
    'claimedAt', v_claimed_at,
    'leaseExpiresAt', v_claimed_at + make_interval(mins => v_lease_minutes)
  );
end;
$$;

create function public.complete_course_presentation_cleanup(
  p_presentation_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested uuid[];
  v_deleted uuid[];
begin
  perform set_config('safetyhub.presentation_cleanup', '1', true);
  select coalesce(array_agg(distinct id order by id), '{}'::uuid[])
  into v_requested
  from unnest(coalesce(p_presentation_ids, '{}'::uuid[])) id
  where id is not null;
  if cardinality(v_requested) > 500 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'PRESENTATION_CLEANUP_LIMIT';
  end if;

  with deleted as (
    delete from public.course_presentations presentation
    where presentation.id = any(v_requested)
      and presentation.status = 'retired'
      and presentation.cleanup_claimed_at is not null
      and not exists (
        select 1 from public.course_drafts draft
        where draft.presentation_id = presentation.id
      )
      and not exists (
        select 1 from public.test_revisions revision
        where revision.presentation_id = presentation.id
      )
    returning presentation.id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[])
  into v_deleted
  from deleted;

  return jsonb_build_object(
    'deletedIds', to_jsonb(v_deleted),
    'skippedIds', to_jsonb(array(
      select id from unnest(v_requested) id
      where not (id = any(v_deleted)) order by id
    )),
    'deleted', cardinality(v_deleted)
  );
end;
$$;

revoke all on function public.claim_stale_course_presentations(integer,integer,integer)
  from public, anon, authenticated, service_role;
revoke all on function public.complete_course_presentation_cleanup(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.claim_stale_course_presentations(integer,integer,integer)
  to service_role;
grant execute on function public.complete_course_presentation_cleanup(uuid[])
  to service_role;

create or replace function private.course_question_variants_valid(p_variants jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_variant jsonb;
  v_question jsonb;
  v_option jsonb;
  v_variant_number integer;
  v_variant_position integer := 0;
  v_question_position integer;
  v_option_position integer;
  v_correct integer;
  v_correct_id text;
  v_variant_id text;
  v_seen_variants integer[] := '{}'::integer[];
  v_seen_ids text[] := '{}'::text[];
  v_local_options text[] := '{}'::text[];
  v_question_id text;
  v_option_id text;
  v_uuid_pattern constant text :=
    '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
begin
  if jsonb_typeof(p_variants) is distinct from 'array'
    or jsonb_array_length(p_variants) <> 3
    or pg_column_size(p_variants) > 1048576 then
    return false;
  end if;

  for v_variant in select value from jsonb_array_elements(p_variants)
  loop
    v_variant_position := v_variant_position + 1;
    v_variant_id := lower(coalesce(v_variant ->> 'id', ''));
    if jsonb_typeof(v_variant) is distinct from 'object'
      or v_variant_id !~ v_uuid_pattern
      or v_variant_id = any(v_seen_ids)
      or coalesce(v_variant ->> 'variantNumber', '') !~ '^[1-3]$'
      or jsonb_typeof(v_variant -> 'questions') is distinct from 'array'
      or jsonb_array_length(v_variant -> 'questions') <> 10 then
      return false;
    end if;
    v_variant_number := (v_variant ->> 'variantNumber')::integer;
    if v_variant_number <> v_variant_position
      or v_variant_number = any(v_seen_variants) then
      return false;
    end if;
    v_seen_ids := array_append(v_seen_ids, v_variant_id);
    v_seen_variants := array_append(v_seen_variants, v_variant_number);

    v_question_position := 0;
    for v_question in select value from jsonb_array_elements(v_variant -> 'questions')
    loop
      v_question_position := v_question_position + 1;
      v_question_id := lower(coalesce(v_question ->> 'id', ''));
      if jsonb_typeof(v_question) is distinct from 'object'
        or v_question_id !~ v_uuid_pattern
        or v_question_id = any(v_seen_ids)
        or (
          v_question ? 'displayOrder'
          and coalesce(v_question ->> 'displayOrder', '')
            <> v_question_position::text
        )
        or char_length(btrim(coalesce(v_question ->> 'text', ''))) not between 3 and 2000
        or coalesce(v_question ->> 'text', '') ~ '[[:cntrl:]]'
        or lower(coalesce(v_question ->> 'text', '')) ~ '<[[:space:]]*script'
        or jsonb_typeof(v_question -> 'options') is distinct from 'array'
        or jsonb_array_length(v_question -> 'options') <> 4
        or char_length(coalesce(v_question ->> 'explanation', '')) > 2000
        or coalesce(v_question ->> 'explanation', '') ~ '[[:cntrl:]]' then
        return false;
      end if;
      v_seen_ids := array_append(v_seen_ids, v_question_id);
      v_local_options := '{}'::text[];

      v_option_position := 0;
      for v_option in select value from jsonb_array_elements(v_question -> 'options')
      loop
        v_option_position := v_option_position + 1;
        v_option_id := lower(coalesce(v_option ->> 'id', ''));
        if jsonb_typeof(v_option) is distinct from 'object'
          or v_option_id !~ v_uuid_pattern
          or v_option_id = any(v_seen_ids)
          or (
            v_option ? 'displayOrder'
            and coalesce(v_option ->> 'displayOrder', '')
              <> v_option_position::text
          )
          or char_length(btrim(coalesce(v_option ->> 'text', ''))) not between 1 and 1000
          or coalesce(v_option ->> 'text', '') ~ '[[:cntrl:]]'
          or lower(coalesce(v_option ->> 'text', '')) ~ '<[[:space:]]*script' then
          return false;
        end if;
        v_seen_ids := array_append(v_seen_ids, v_option_id);
        v_local_options := array_append(v_local_options, v_option_id);
      end loop;

      v_correct_id := lower(coalesce(v_question ->> 'correctOptionId', ''));
      if v_correct_id <> '' then
        if v_correct_id !~ v_uuid_pattern or not (v_correct_id = any(v_local_options)) then
          return false;
        end if;
        if coalesce(v_question ->> 'correctOptionIndex', '') <> '' then
          if coalesce(v_question ->> 'correctOptionIndex', '') !~ '^[0-3]$' then
            return false;
          end if;
          v_correct := (v_question ->> 'correctOptionIndex')::integer;
          if v_local_options[v_correct + 1] <> v_correct_id then
            return false;
          end if;
        end if;
      elsif coalesce(v_question ->> 'correctOptionIndex', '') ~ '^[0-3]$' then
        v_correct := (v_question ->> 'correctOptionIndex')::integer;
        v_correct_id := v_local_options[v_correct + 1];
      else
        return false;
      end if;
    end loop;
  end loop;

  return v_seen_variants @> array[1,2,3]
    and cardinality(v_seen_ids) = 153;
exception when others then
  return false;
end;
$$;

-- Produce the exact immutable representation used for hashing, publication and
-- linked snapshot export. Unsupported keys are intentionally discarded;
-- display order is derived from array order and correct answers become IDs.
create function private.normalize_course_question_variants(p_variants jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', lower(variant.value ->> 'id'),
    'variantNumber', variant.ordinality,
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', lower(question.value ->> 'id'),
        'text', btrim(question.value ->> 'text'),
        'displayOrder', question.ordinality,
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', lower(option.value ->> 'id'),
            'text', btrim(option.value ->> 'text'),
            'displayOrder', option.ordinality
          ) order by option.ordinality), '[]'::jsonb)
          from jsonb_array_elements(question.value -> 'options')
            with ordinality option(value, ordinality)
        ),
        'correctOptionId', lower(coalesce(
          nullif(question.value ->> 'correctOptionId', ''),
          (question.value -> 'options'
            -> ((question.value ->> 'correctOptionIndex')::integer)) ->> 'id'
        )),
        'explanation', coalesce(btrim(question.value ->> 'explanation'), '')
      ) order by question.ordinality), '[]'::jsonb)
      from jsonb_array_elements(variant.value -> 'questions')
        with ordinality question(value, ordinality)
    )
  ) order by variant.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_variants)
    with ordinality variant(value, ordinality);
$$;

create function private.editor_course_question_variants(p_variants jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', variant.value ->> 'id',
    'variantNumber', (variant.value ->> 'variantNumber')::integer,
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', question.value ->> 'id',
        'text', coalesce(question.value ->> 'text', ''),
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', option.value ->> 'id',
            'text', coalesce(option.value ->> 'text', '')
          ) order by option.ordinality), '[]'::jsonb)
          from jsonb_array_elements(coalesce(
            question.value -> 'options', '[]'::jsonb
          )) with ordinality option(value, ordinality)
        ),
        'correctOptionId', coalesce(
          nullif(question.value ->> 'correctOptionId', ''),
          (question.value -> 'options'
            -> ((question.value ->> 'correctOptionIndex')::integer)) ->> 'id',
          ''
        ),
        'explanation', coalesce(question.value ->> 'explanation', '')
      ) order by question.ordinality), '[]'::jsonb)
      from jsonb_array_elements(coalesce(
        variant.value -> 'questions', '[]'::jsonb
      )) with ordinality question(value, ordinality)
    )
  ) order by variant.ordinality), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_variants, '[]'::jsonb))
    with ordinality variant(value, ordinality);
$$;

-- PostgreSQL jsonb::text has a stable server representation, but it is not the
-- canonical JSON serialization used by the repository snapshot tools.  Keep
-- hashing reproducible outside PostgreSQL by sorting object keys with the C
-- collation and emitting compact JSON recursively (arrays retain their order).
create function private.jsonb_canonical_text(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(
        to_jsonb(entry.key)::text || ':'
          || private.jsonb_canonical_text(entry.value),
        ',' order by entry.key collate "C"
      ), '') || '}'
      into v_result
      from jsonb_each(p_value) entry;
      return v_result;
    when 'array' then
      select '[' || coalesce(string_agg(
        private.jsonb_canonical_text(item.value),
        ',' order by item.ordinality
      ), '') || ']'
      into v_result
      from jsonb_array_elements(p_value)
        with ordinality item(value, ordinality);
      return v_result;
    else
      return p_value::text;
  end case;
end;
$$;

create function private.course_content_hash_v3(
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_display_order integer,
  p_presentation_sha256 text,
  p_presentation_page_count integer,
  p_duration_minutes integer,
  p_pass_score integer,
  p_attempts_per_calendar_day integer,
  p_attempt_reset_timezone text,
  p_question_variants jsonb,
  p_seo jsonb,
  p_jurisdiction text,
  p_effective_date date,
  p_sources jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(private.jsonb_canonical_text(
    jsonb_build_object(
    'slug', p_slug,
    'title', p_title,
    'description', p_description,
    'icon', p_icon,
    'displayOrder', p_display_order,
    'presentationSha256', coalesce(p_presentation_sha256, ''),
    'presentationPageCount', coalesce(p_presentation_page_count, 0),
    'durationMinutes', p_duration_minutes,
    'passScore', p_pass_score,
    'attemptsPerCalendarDay', p_attempts_per_calendar_day,
    'attemptResetTimezone', p_attempt_reset_timezone,
    'questionVariants', p_question_variants,
    'seo', p_seo,
    'jurisdiction', coalesce(p_jurisdiction, ''),
    'effectiveDate', coalesce(p_effective_date::text, ''),
    'sources', coalesce(p_sources, '[]'::jsonb)
  )), 'utf8'), 'sha256'), 'hex');
$$;

-- Extend the existing immutable-row trigger with the two v3 revision tables.
create or replace function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
  v_content_delete text := coalesce(current_setting('safetyhub.content_delete', true), '');
begin
  if TG_OP = 'DELETE'
    and v_content_delete = '1'
    and (
      (TG_TABLE_SCHEMA = 'public'
        and TG_TABLE_NAME in ('test_revisions', 'article_revisions', 'test_revision_variants'))
      or (TG_TABLE_SCHEMA = 'private'
        and TG_TABLE_NAME in ('test_revision_answer_keys', 'test_revision_variant_answer_keys'))
    ) then
    return old;
  end if;
  if TG_OP = 'UPDATE'
    and TG_TABLE_SCHEMA = 'public'
    and TG_TABLE_NAME = 'test_revisions'
    and v_purge_actor <> ''
    and to_jsonb(new) - 'published_by' = to_jsonb(old) - 'published_by'
    and to_jsonb(old) ->> 'published_by' = v_purge_actor
    and to_jsonb(new) -> 'published_by' = 'null'::jsonb then
    return new;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = TG_TABLE_NAME || '_IMMUTABLE';
end;
$$;

create trigger test_revision_variants_immutable
before update or delete on public.test_revision_variants
for each row execute function private.reject_immutable_row_change();

create trigger test_revision_variant_answer_keys_immutable
before update or delete on private.test_revision_variant_answer_keys
for each row execute function private.reject_immutable_row_change();

-- Defensive rolling-deploy fallback: if an old v2 publisher creates a revision
-- after this migration, the first learner request materializes one legacy
-- variant without exposing its key. New v3 publication never takes this path.
create function private.ensure_legacy_revision_variant(p_revision_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_revision public.test_revisions%rowtype;
  v_legacy_key private.test_revision_answer_keys%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_variant_id uuid := gen_random_uuid();
  v_correct_option_ids jsonb;
begin
  select * into v_variant
  from public.test_revision_variants variant
  where variant.revision_id = p_revision_id
  order by variant.variant_number
  limit 1;
  if found then
    return v_variant.id;
  end if;

  select * into v_revision
  from public.test_revisions revision
  where revision.id = p_revision_id
  for share;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_legacy_key
  from private.test_revision_answer_keys answer_key
  where answer_key.revision_id = p_revision_id;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  insert into public.test_revision_variants(
    id, stable_id, revision_id, variant_number, questions, question_count
  ) values (
    v_variant_id, v_variant_id, v_revision.id, 1,
    v_revision.questions, v_revision.question_count
  )
  on conflict (revision_id, variant_number) do nothing;

  select * into v_variant
  from public.test_revision_variants variant
  where variant.revision_id = p_revision_id and variant.variant_number = 1;

  select coalesce(jsonb_agg(
    to_jsonb(question.value -> 'options'
      -> v_legacy_key.correct_positions[question.ordinality::integer] ->> 'id')
    order by question.ordinality
  ), '[]'::jsonb)
  into v_correct_option_ids
  from jsonb_array_elements(v_revision.questions)
    with ordinality question(value, ordinality);

  insert into private.test_revision_variant_answer_keys(
    variant_id, revision_id, correct_option_ids, explanations
  ) values (
    v_variant.id, v_revision.id, v_correct_option_ids,
    to_jsonb(v_legacy_key.explanations)
  ) on conflict (variant_id) do nothing;

  return v_variant.id;
end;
$$;

revoke all on function private.course_question_variants_valid(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.jsonb_canonical_text(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.normalize_course_question_variants(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.editor_course_question_variants(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function private.course_content_hash_v3(
  text,text,text,text,integer,text,integer,integer,integer,integer,text,jsonb,jsonb,text,date,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.ensure_legacy_revision_variant(uuid)
  from public, anon, authenticated, service_role;

create function private.public_questions_from_draft(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', question.value ->> 'id',
    'text', btrim(question.value ->> 'text'),
    'position', question.ordinality,
    'options', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', option.value ->> 'id',
        'text', btrim(option.value ->> 'text'),
        'position', option.ordinality
      ) order by option.ordinality), '[]'::jsonb)
      from jsonb_array_elements(question.value -> 'options')
        with ordinality option(value, ordinality)
    )
  ) order by question.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality);
$$;

create function private.correct_option_ids_from_draft(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(
    coalesce(
      nullif(lower(question.value ->> 'correctOptionId'), ''),
      (question.value -> 'options'
        -> ((question.value ->> 'correctOptionIndex')::integer)) ->> 'id'
    )
  ) order by question.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality);
$$;

create function private.explanations_from_draft(p_questions jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(
    coalesce(nullif(btrim(question.value ->> 'explanation'), ''), '')
  ) order by question.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_questions)
    with ordinality question(value, ordinality);
$$;

create function private.reconstruct_course_question_variants(p_revision_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', variant.stable_id,
    'variantNumber', variant.variant_number,
    'questions', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', question.value ->> 'id',
        'text', question.value ->> 'text',
        'displayOrder', question.ordinality,
        'options', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'id', option.value ->> 'id',
            'text', option.value ->> 'text',
            'displayOrder', option.ordinality
          ) order by option.ordinality), '[]'::jsonb)
          from jsonb_array_elements(question.value -> 'options')
            with ordinality option(value, ordinality)
        ),
        'correctOptionId', answer_key.correct_option_ids
          ->> (question.ordinality::integer - 1),
        'explanation', coalesce(answer_key.explanations
          ->> (question.ordinality::integer - 1), '')
      ) order by question.ordinality), '[]'::jsonb)
      from jsonb_array_elements(variant.questions)
        with ordinality question(value, ordinality)
    )
  ) order by variant.variant_number), '[]'::jsonb)
  from public.test_revision_variants variant
  join private.test_revision_variant_answer_keys answer_key
    on answer_key.variant_id = variant.id
    and answer_key.revision_id = variant.revision_id
  where variant.revision_id = p_revision_id;
$$;

revoke all on function private.public_questions_from_draft(jsonb),
  private.correct_option_ids_from_draft(jsonb),
  private.explanations_from_draft(jsonb),
  private.reconstruct_course_question_variants(uuid)
from public, anon, authenticated, service_role;

create function private.save_course_draft_v3_unmetered(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_display_order integer,
  p_presentation_id uuid,
  p_duration_minutes integer,
  p_pass_score integer,
  p_attempts_per_calendar_day integer,
  p_attempt_reset_timezone text,
  p_question_variants jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_test_id uuid;
  v_slug text := lower(btrim(p_slug));
  v_hash text;
  v_question_variants jsonb := p_question_variants;
  v_sources jsonb := coalesce(p_content_metadata -> 'sources', '[]'::jsonb);
  v_jurisdiction text := nullif(btrim(p_content_metadata ->> 'jurisdiction'), '');
  v_effective_date date := nullif(p_content_metadata ->> 'effectiveDate', '')::date;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if private.course_catalog_maintenance_enabled() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CATALOG_MAINTENANCE';
  end if;
  if v_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
    or char_length(v_slug) > 80
    or char_length(btrim(coalesce(p_title, ''))) not between 3 and 200
    or char_length(coalesce(p_description, '')) > 1000
    or char_length(coalesce(p_icon, '')) not between 1 and 40
    or p_display_order not between 1 and 1000
    or p_duration_minutes not between 1 and 120
    or p_pass_score not between 1 and 10
    or p_attempts_per_calendar_day not between 1 and 50
    or p_attempt_reset_timezone is distinct from 'Asia/Oral'
    or jsonb_typeof(p_question_variants) is distinct from 'array'
    or jsonb_array_length(p_question_variants) > 3
    or pg_column_size(p_question_variants) > 1048576
    or jsonb_typeof(p_seo) is distinct from 'object'
    or pg_column_size(p_seo) > 32768
    or jsonb_typeof(p_content_metadata) is distinct from 'object'
    or char_length(coalesce(v_jurisdiction, '')) > 120
    or jsonb_typeof(v_sources) is distinct from 'array'
    or jsonb_array_length(v_sources) > 10
    or exists (
      select 1 from jsonb_array_elements(v_sources) source
      where jsonb_typeof(source) is distinct from 'object'
        or char_length(coalesce(source ->> 'title', '')) > 240
        or char_length(coalesce(source ->> 'url', '')) > 2048
        or ((nullif(btrim(source ->> 'title'), '') is null)
          is distinct from (nullif(btrim(source ->> 'url'), '') is null))
        or (nullif(btrim(source ->> 'url'), '') is not null
          and btrim(source ->> 'url') !~ '^https://[^[:space:]]+$')
    ) then
    raise exception using errcode = 'check_violation', message = 'COURSE_DRAFT_INVALID';
  end if;

  select coalesce(jsonb_agg(
    source order by (source ->> 'title') collate "C"
  ), '[]'::jsonb)
  into v_sources
  from jsonb_array_elements(v_sources) source
  where nullif(btrim(source ->> 'title'), '') is not null;

  if private.course_question_variants_valid(p_question_variants) then
    v_question_variants := private.normalize_course_question_variants(
      p_question_variants
    );
  end if;

  if p_presentation_id is not null then
    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = p_presentation_id
    for share;
    if not found or v_presentation.status <> 'ready' then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'PRESENTATION_NOT_READY';
    end if;
    if p_test_id is null or v_presentation.course_id is distinct from p_test_id then
      raise exception using errcode = 'foreign_key_violation', message = 'PRESENTATION_IN_USE';
    end if;
  end if;

  v_hash := private.course_content_hash_v3(
    v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
    coalesce(nullif(btrim(p_icon), ''), 'factory'), p_display_order,
    v_presentation.sha256, v_presentation.page_count,
    p_duration_minutes, p_pass_score, p_attempts_per_calendar_day,
    p_attempt_reset_timezone, v_question_variants, p_seo,
    v_jurisdiction, v_effective_date, v_sources
  );

  if p_test_id is null then
    if exists (select 1 from public.tests test where test.slug = v_slug)
      or exists (select 1 from public.course_drafts draft where draft.slug = v_slug)
      or exists (
        select 1 from public.course_slug_redirects redirect where redirect.old_slug = v_slug
      ) then
      raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
    end if;
    insert into public.tests (
      slug, title, description, icon, display_order, seo, draft_content,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, status, jurisdiction, effective_date, sources,
      content_hash, created_by, updated_by
    ) values (
      v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_display_order, p_seo,
      jsonb_build_object('questions', '[]'::jsonb, 'questionVariants', v_question_variants),
      p_duration_minutes, p_pass_score, p_attempts_per_calendar_day,
      p_attempt_reset_timezone, 'draft', v_jurisdiction, v_effective_date,
      v_sources, v_hash, v_actor_id, v_actor_id
    ) returning * into v_test;
    v_test_id := v_test.id;
    insert into public.course_drafts (
      test_id, slug, title, description, icon, display_order, presentation_id,
      duration_minutes, pass_score, attempts_per_calendar_day,
      attempt_reset_timezone, content, questions, question_variants, seo,
      jurisdiction, effective_date, sources, content_hash, updated_by
    ) values (
      v_test.id, v_slug, btrim(p_title), coalesce(btrim(p_description), ''),
      coalesce(nullif(btrim(p_icon), ''), 'factory'), p_display_order, null,
      p_duration_minutes, p_pass_score, p_attempts_per_calendar_day,
      p_attempt_reset_timezone, '{"modules":[]}'::jsonb, '[]'::jsonb,
      v_question_variants, p_seo, v_jurisdiction, v_effective_date, v_sources,
      v_hash, v_actor_id
    ) returning * into v_draft;
  else
    select * into v_test from public.tests where id = p_test_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
    end if;
    select * into v_draft
    from public.course_drafts where test_id = p_test_id for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
    end if;
    if p_expected_version is null or v_draft.draft_version <> p_expected_version then
      raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
    end if;
    if v_slug <> v_draft.slug and (
      exists (select 1 from public.tests other
        where other.id <> p_test_id and other.slug = v_slug)
      or exists (select 1 from public.course_drafts other
        where other.test_id <> p_test_id and other.slug = v_slug)
      or exists (select 1 from public.course_slug_redirects redirect
        where redirect.old_slug = v_slug and redirect.test_id <> p_test_id)
    ) then
      raise exception using errcode = 'unique_violation', message = 'COURSE_SLUG_TAKEN';
    end if;
    update public.course_drafts
    set slug = v_slug,
        title = btrim(p_title),
        description = coalesce(btrim(p_description), ''),
        icon = coalesce(nullif(btrim(p_icon), ''), 'factory'),
        display_order = p_display_order,
        presentation_id = p_presentation_id,
        duration_minutes = p_duration_minutes,
        pass_score = p_pass_score,
        attempts_per_calendar_day = p_attempts_per_calendar_day,
        attempt_reset_timezone = p_attempt_reset_timezone,
        content = '{"modules":[]}'::jsonb,
        questions = '[]'::jsonb,
        question_variants = v_question_variants,
        seo = p_seo,
        jurisdiction = v_jurisdiction,
        effective_date = v_effective_date,
        sources = v_sources,
        content_hash = v_hash,
        draft_version = draft_version + 1,
        updated_by = v_actor_id,
        updated_at = statement_timestamp()
    where test_id = p_test_id
    returning * into v_draft;
    v_test_id := p_test_id;
    if v_test.current_revision_id is null then
      update public.tests
      set slug = v_draft.slug,
          title = v_draft.title,
          description = v_draft.description,
          icon = v_draft.icon,
          display_order = v_draft.display_order,
          seo = v_draft.seo,
          draft_content = jsonb_build_object(
            'questions', '[]'::jsonb, 'questionVariants', v_draft.question_variants
          ),
          duration_minutes = v_draft.duration_minutes,
          pass_score = v_draft.pass_score,
          attempts_per_calendar_day = v_draft.attempts_per_calendar_day,
          attempt_reset_timezone = v_draft.attempt_reset_timezone,
          jurisdiction = v_draft.jurisdiction,
          effective_date = v_draft.effective_date,
          sources = v_draft.sources,
          content_hash = v_draft.content_hash,
          updated_by = v_actor_id
      where id = p_test_id;
    end if;
  end if;

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    v_actor_id, 'test', v_test_id::text, 'course.draft_saved',
    jsonb_build_object(
      'slug', v_draft.slug,
      'displayOrder', v_draft.display_order,
      'presentationId', v_draft.presentation_id,
      'contentHash', v_draft.content_hash,
      'draftVersion', v_draft.draft_version
    )
  );

  return jsonb_build_object(
    'id', v_test_id,
    'slug', v_draft.slug,
    'status', case when v_test.status = 'published' then 'published' else 'draft' end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash
  );
end;
$$;

create function private.publish_course_revision_v3_unmetered(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_revision_id uuid := gen_random_uuid();
  v_version integer;
  v_variant jsonb;
  v_questions jsonb;
  v_public_questions jsonb;
  v_correct_option_ids jsonb;
  v_explanations jsonb;
  v_variant_id uuid;
  v_first_questions jsonb;
  v_first_correct_positions smallint[] := '{}'::smallint[];
  v_first_explanations text[] := '{}'::text[];
  v_question jsonb;
  v_correct_position smallint;
begin
  if coalesce(current_setting('safetyhub.catalog_activation', true), '') <> '1' then
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    if private.course_catalog_maintenance_enabled() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_CATALOG_MAINTENANCE';
    end if;
  end if;
  select * into v_test from public.tests where id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_draft
  from public.course_drafts where test_id = p_test_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
  end if;
  if p_expected_content_hash is null
    or v_draft.content_hash is distinct from p_expected_content_hash then
    raise exception using errcode = 'serialization_failure', message = 'COURSE_DRAFT_CONFLICT';
  end if;
  if not private.course_question_variants_valid(v_draft.question_variants) then
    raise exception using errcode = 'check_violation', message = 'TEST_VARIANTS_INVALID';
  end if;
  if v_draft.presentation_id is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_NOT_READY';
  end if;
  select * into v_presentation
  from public.course_presentations presentation
  where presentation.id = v_draft.presentation_id
    and presentation.course_id = v_draft.test_id
    and presentation.status = 'ready'
  for share;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_NOT_READY';
  end if;
  if coalesce(current_setting('safetyhub.catalog_activation', true), '') <> '1'
    and exists (
      select 1 from public.tests other
      where other.id <> p_test_id
        and other.status = 'published'
        and other.display_order = v_draft.display_order
    ) then
    raise exception using errcode = 'unique_violation', message = 'COURSE_DISPLAY_ORDER_TAKEN';
  end if;

  select value -> 'questions' into v_questions
  from jsonb_array_elements(v_draft.question_variants) item(value)
  where value ->> 'variantNumber' = '1';
  v_first_questions := private.public_questions_from_draft(v_questions);
  for v_question in select value from jsonb_array_elements(v_questions)
  loop
    if nullif(v_question ->> 'correctOptionId', '') is not null then
      select (option.ordinality - 1)::smallint into v_correct_position
      from jsonb_array_elements(v_question -> 'options')
        with ordinality option(value, ordinality)
      where option.value ->> 'id' = v_question ->> 'correctOptionId';
    else
      v_correct_position := (v_question ->> 'correctOptionIndex')::smallint;
    end if;
    v_first_correct_positions := array_append(
      v_first_correct_positions, v_correct_position
    );
    v_first_explanations := array_append(
      v_first_explanations,
      coalesce(nullif(btrim(v_question ->> 'explanation'), ''), '')
    );
  end loop;

  v_version := v_test.content_version + 1;
  insert into public.test_revisions (
    id, test_id, version, slug, title, description, icon, display_order,
    presentation_id, content, seo, content_hash, jurisdiction, effective_date,
    sources, questions, question_count, duration_minutes, pass_score,
    attempts_per_calendar_day, attempt_reset_timezone, published_by
  ) values (
    v_revision_id, v_test.id, v_version, v_draft.slug, v_draft.title,
    v_draft.description, v_draft.icon, v_draft.display_order,
    v_draft.presentation_id, '{"modules":[]}'::jsonb, v_draft.seo,
    v_draft.content_hash, v_draft.jurisdiction, v_draft.effective_date,
    v_draft.sources, v_first_questions, 10, v_draft.duration_minutes,
    v_draft.pass_score, v_draft.attempts_per_calendar_day,
    v_draft.attempt_reset_timezone, p_actor_id
  );

  for v_variant in
    select value
    from jsonb_array_elements(v_draft.question_variants) item(value)
    order by (value ->> 'variantNumber')::integer
  loop
    v_questions := v_variant -> 'questions';
    v_public_questions := private.public_questions_from_draft(v_questions);
    v_correct_option_ids := private.correct_option_ids_from_draft(v_questions);
    v_explanations := private.explanations_from_draft(v_questions);
    insert into public.test_revision_variants(
      stable_id, revision_id, variant_number, questions, question_count
    ) values (
      (v_variant ->> 'id')::uuid, v_revision_id,
      (v_variant ->> 'variantNumber')::smallint,
      v_public_questions, 10
    ) returning id into v_variant_id;
    insert into private.test_revision_variant_answer_keys(
      variant_id, revision_id, correct_option_ids, explanations
    ) values (
      v_variant_id, v_revision_id, v_correct_option_ids, v_explanations
    );
  end loop;

  -- Keep the legacy first-variant key solely for old server deployments during
  -- the rolling release. Browser roles have no access to the private table.
  insert into private.test_revision_answer_keys(
    revision_id, correct_positions, explanations
  ) values (
    v_revision_id, v_first_correct_positions, v_first_explanations
  );

  if v_test.current_revision_id is not null and v_test.slug <> v_draft.slug then
    delete from public.course_slug_redirects
    where old_slug = v_draft.slug and test_id = v_test.id;
    insert into public.course_slug_redirects(old_slug, test_id)
    values (v_test.slug, v_test.id)
    on conflict (old_slug) do update set test_id = excluded.test_id;
  end if;

  update public.tests
  set slug = v_draft.slug,
      title = v_draft.title,
      description = v_draft.description,
      icon = v_draft.icon,
      display_order = v_draft.display_order,
      seo = v_draft.seo,
      draft_content = jsonb_build_object(
        'questions', '[]'::jsonb, 'questionVariants', v_draft.question_variants
      ),
      current_revision_id = v_revision_id,
      content_version = v_version,
      duration_minutes = v_draft.duration_minutes,
      pass_score = v_draft.pass_score,
      attempts_per_calendar_day = v_draft.attempts_per_calendar_day,
      attempt_reset_timezone = v_draft.attempt_reset_timezone,
      status = 'published',
      jurisdiction = v_draft.jurisdiction,
      effective_date = v_draft.effective_date,
      sources = v_draft.sources,
      content_hash = v_draft.content_hash,
      updated_by = p_actor_id
  where id = v_test.id;

  insert into public.admin_audit_log (
    actor_user_id, target_type, target_id, action, after_data
  ) values (
    p_actor_id, 'test', v_test.id::text, 'course.published',
    jsonb_build_object(
      'slug', v_draft.slug,
      'version', v_version,
      'revisionId', v_revision_id,
      'presentationId', v_draft.presentation_id,
      'variantCount', 3,
      'questionCount', 10,
      'contentHash', v_draft.content_hash
    )
  );

  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_draft.slug,
    'status', 'published',
    'version', v_version,
    'revisionId', v_revision_id,
    'presentationId', v_draft.presentation_id,
    'contentHash', v_draft.content_hash
  );
end;
$$;

create function public.save_course_draft_v3(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_display_order integer,
  p_presentation_id uuid,
  p_duration_minutes integer,
  p_pass_score integer,
  p_attempts_per_calendar_day integer,
  p_attempt_reset_timezone text,
  p_question_variants jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.save_course_draft_v3_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title,
      p_description, p_icon, p_display_order, p_presentation_id,
      p_duration_minutes, p_pass_score, p_attempts_per_calendar_day,
      p_attempt_reset_timezone, p_question_variants, p_seo, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.publish_course_revision_v3(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  begin
    v_result := private.publish_course_revision_v3_unmetered(
      v_actor_id, p_test_id, p_expected_content_hash
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.save_and_publish_course_v3(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_display_order integer,
  p_presentation_id uuid,
  p_duration_minutes integer,
  p_pass_score integer,
  p_attempts_per_calendar_day integer,
  p_attempt_reset_timezone text,
  p_question_variants jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved jsonb;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_saved := private.save_course_draft_v3_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title,
      p_description, p_icon, p_display_order, p_presentation_id,
      p_duration_minutes, p_pass_score, p_attempts_per_calendar_day,
      p_attempt_reset_timezone, p_question_variants, p_seo, p_content_metadata
    );
    v_result := private.publish_course_revision_v3_unmetered(
      p_actor_id, (v_saved ->> 'id')::uuid, v_saved ->> 'contentHash'
    );
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object(
        'draftVersion', (v_saved ->> 'draftVersion')::bigint
      )
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.get_course_editor_payload_v3(
  p_actor_id uuid,
  p_test_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_test public.tests%rowtype;
  v_draft public.course_drafts%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_variants_valid boolean;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_test from public.tests where id = p_test_id;
  select * into v_draft from public.course_drafts where test_id = p_test_id;
  if v_test.id is null or v_draft.test_id is null then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  if v_draft.presentation_id is not null then
    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = v_draft.presentation_id;
  end if;
  v_variants_valid := private.course_question_variants_valid(v_draft.question_variants);

  return jsonb_build_object(
    'id', v_test.id,
    'slug', v_draft.slug,
    'title', v_draft.title,
    'description', v_draft.description,
    'icon', v_draft.icon,
    'displayOrder', v_draft.display_order,
    'presentation', case when v_presentation.id is null then null else jsonb_build_object(
      'id', v_presentation.id,
      'courseId', v_presentation.course_id,
      'bucket', v_presentation.storage_bucket,
      'path', v_presentation.storage_path,
      'thumbnailPath', v_presentation.thumbnail_path,
      'sourceFilename', v_presentation.source_filename,
      'mimeType', v_presentation.mime_type,
      'byteSize', v_presentation.byte_size,
      'sha256', v_presentation.sha256,
      'pageCount', v_presentation.page_count,
      'aspectRatio', v_presentation.aspect_ratio,
      'status', v_presentation.status,
      'validationError', v_presentation.validation_error,
      'validatedAt', v_presentation.validated_at
    ) end,
    'policy', jsonb_build_object(
      'durationMinutes', v_draft.duration_minutes,
      'passScore', v_draft.pass_score,
      'attemptsPerCalendarDay', v_draft.attempts_per_calendar_day,
      'resetTimezone', v_draft.attempt_reset_timezone
    ),
    'durationMinutes', v_draft.duration_minutes,
    'passScore', v_draft.pass_score,
    'attemptsPerCalendarDay', v_draft.attempts_per_calendar_day,
    'attemptResetTimezone', v_draft.attempt_reset_timezone,
    'jurisdiction', coalesce(v_draft.jurisdiction, ''),
    'effectiveDate', coalesce(v_draft.effective_date::text, ''),
    'sources', v_draft.sources,
    'status', case when v_test.status = 'published' then 'published' else 'draft' end,
    'publicationState', case
      when v_test.current_revision_id is null then 'never_published'
      when v_test.status <> 'published' then 'draft'
      when v_test.content_hash = v_draft.content_hash then 'published'
      else 'published_with_draft_changes'
    end,
    'draftVersion', v_draft.draft_version,
    'contentHash', v_draft.content_hash,
    'seo', v_draft.seo,
    'questionVariants', private.editor_course_question_variants(
      v_draft.question_variants
    ),
    'validation', jsonb_build_object(
      'presentationReady', coalesce(v_presentation.status = 'ready', false),
      'variantsValid', v_variants_valid,
      'canPublish', coalesce(v_presentation.status = 'ready', false) and v_variants_valid,
      'errors', to_jsonb(array_remove(array[
        case when coalesce(v_presentation.status = 'ready', false) then null
          else 'PRESENTATION_NOT_READY' end,
        case when v_variants_valid then null else 'TEST_VARIANTS_INVALID' end
      ], null))
    )
  );
end;
$$;

revoke all on function private.save_course_draft_v3_unmetered(
  uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function private.publish_course_revision_v3_unmetered(uuid,uuid,text)
  from public, anon, authenticated, service_role;

revoke all on function public.save_course_draft_v3(
  uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.publish_course_revision_v3(uuid,uuid,text)
  from public, anon, authenticated, service_role;
revoke all on function public.save_and_publish_course_v3(
  uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb
) from public, anon, authenticated, service_role;
revoke all on function public.get_course_editor_payload_v3(uuid,uuid)
  from public, anon, authenticated, service_role;

grant execute on function public.save_course_draft_v3(
  uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.publish_course_revision_v3(uuid,uuid,text)
  to authenticated;
grant execute on function public.save_and_publish_course_v3(
  uuid,uuid,bigint,text,text,text,text,integer,uuid,integer,integer,integer,text,jsonb,jsonb,jsonb
) to authenticated;
grant execute on function public.get_course_editor_payload_v3(uuid,uuid)
  to authenticated;

-- Trusted linked-content export surface. It deliberately contains answer keys
-- and is therefore executable only with service_role. The returned variants
-- are reconstructed solely from immutable revision rows and must reproduce the
-- stored v3 content hash before any payload is emitted.
create function public.get_published_course_snapshot_v3(p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_test public.tests%rowtype;
  v_revision public.test_revisions%rowtype;
  v_presentation public.course_presentations%rowtype;
  v_variants jsonb;
  v_hash text;
begin
  select * into v_test
  from public.tests test
  where test.id = p_test_id and test.status = 'published';
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_test.current_revision_id;
  select * into v_presentation
  from public.course_presentations presentation
  where presentation.id = v_revision.presentation_id
    and presentation.course_id = v_test.id
    and presentation.status = 'ready';
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PRESENTATION_NOT_READY';
  end if;

  v_variants := private.reconstruct_course_question_variants(v_revision.id);
  if not private.course_question_variants_valid(v_variants) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'CATALOG_SNAPSHOT_VARIANTS_INVALID';
  end if;
  v_hash := private.course_content_hash_v3(
    v_revision.slug, v_revision.title, v_revision.description,
    v_revision.icon, v_revision.display_order, v_presentation.sha256,
    v_presentation.page_count, v_revision.duration_minutes,
    v_revision.pass_score, v_revision.attempts_per_calendar_day,
    v_revision.attempt_reset_timezone, v_variants, v_revision.seo,
    v_revision.jurisdiction, v_revision.effective_date, v_revision.sources
  );
  if v_hash is distinct from v_revision.content_hash then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'CATALOG_SNAPSHOT_HASH_MISMATCH';
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'id', v_test.id,
    'revisionId', v_revision.id,
    'revisionVersion', v_revision.version,
    'slug', v_revision.slug,
    'title', v_revision.title,
    'description', v_revision.description,
    'icon', v_revision.icon,
    'displayOrder', v_revision.display_order,
    'updatedAt', v_revision.published_at,
    'jurisdiction', coalesce(v_revision.jurisdiction, ''),
    'effectiveDate', coalesce(v_revision.effective_date::text, ''),
    'sources', v_revision.sources,
    'seo', v_revision.seo,
    'policy', jsonb_build_object(
      'durationMinutes', v_revision.duration_minutes,
      'passScore', v_revision.pass_score,
      'questionCount', v_revision.question_count,
      'variantCount', jsonb_array_length(v_variants),
      'attemptsPerCalendarDay', v_revision.attempts_per_calendar_day,
      'resetTimezone', v_revision.attempt_reset_timezone
    ),
    'presentation', jsonb_build_object(
      'id', v_presentation.id,
      'storageBucket', v_presentation.storage_bucket,
      'storagePath', v_presentation.storage_path,
      'thumbnailPath', v_presentation.thumbnail_path,
      'sourceFilename', v_presentation.source_filename,
      'mimeType', v_presentation.mime_type,
      'byteSize', v_presentation.byte_size,
      'sha256', v_presentation.sha256,
      'pageCount', v_presentation.page_count,
      'aspectRatio', v_presentation.aspect_ratio
    ),
    'variants', v_variants,
    'contentHash', v_revision.content_hash
  );
end;
$$;

revoke all on function public.get_published_course_snapshot_v3(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_published_course_snapshot_v3(uuid)
  to service_role;

create or replace function private.rpc_error_envelope(
  p_sqlstate text,
  p_message text,
  p_detail text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_state text := case
    when coalesce(p_sqlstate, '') ~ '^[0-9A-Z]{5}$' then p_sqlstate
    else 'P0001'
  end;
  v_message text;
  v_detail jsonb;
  v_retry_at_text text;
  v_retry_at timestamptz;
begin
  if coalesce(p_message, '') ~ '^[A-Z][A-Z0-9_]{1,95}(:[0-9]{1,10})?$' then
    v_message := p_message;
  else
    v_message := case
      when v_state = '42501' then 'FORBIDDEN'
      when v_state = '23505' then 'CONFLICT'
      when v_state in ('23502', '23503', '23514', '23P01') then 'CONSTRAINT_VIOLATION'
      when v_state in ('22003', '22007', '22023') then 'INVALID_REQUEST'
      when v_state = 'P0002' then 'NOT_FOUND'
      when v_state = '55000' then 'INVALID_STATE'
      when v_state in ('40001', '40P01') then 'RETRYABLE_TRANSACTION_ERROR'
      else 'RPC_MUTATION_FAILED'
    end;
  end if;

  -- ATTEMPT_DAILY_LIMIT is the v3 product contract. Keep the former rolling
  -- code parse-only while old application instances can still finish a
  -- rolling deployment; no v3 admission path emits it.
  if v_state = '54000'
    and v_message in ('ATTEMPT_ROLLING_LIMIT', 'ATTEMPT_DAILY_LIMIT')
    and p_detail is not null
    and octet_length(p_detail) between 20 and 96 then
    begin
      v_detail := p_detail::jsonb;
      if jsonb_typeof(v_detail) = 'object'
        and (select count(*) from jsonb_object_keys(v_detail)) = 1
        and v_detail ? 'retryAt'
        and jsonb_typeof(v_detail -> 'retryAt') = 'string' then
        v_retry_at_text := v_detail ->> 'retryAt';
        if char_length(v_retry_at_text) between 20 and 40
          and v_retry_at_text ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?([+-][0-9]{2}(:[0-9]{2})?|Z)$' then
          v_retry_at := v_retry_at_text::timestamptz;
          if v_retry_at is not null then
            v_detail := jsonb_build_object(
              'retryAt',
              to_char(v_retry_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            );
          else
            v_detail := null;
          end if;
        else
          v_detail := null;
        end if;
      else
        v_detail := null;
      end if;
    exception when others then
      v_detail := null;
    end;
  end if;

  return jsonb_build_object(
    '__safetyhubRpcError',
    jsonb_strip_nulls(jsonb_build_object(
      'version', 1,
      'code', v_state,
      'message', v_message,
      'details', v_detail
    ))
  );
end;
$$;

create function public.get_course_catalog_maintenance(p_actor_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_state private.course_catalog_runtime_state%rowtype;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select * into v_state
  from private.course_catalog_runtime_state state
  where state.singleton;
  return jsonb_build_object(
    'enabled', v_state.maintenance_enabled,
    'updatedAt', v_state.updated_at
  );
end;
$$;

create function public.set_course_catalog_maintenance(
  p_actor_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_state private.course_catalog_runtime_state%rowtype;
  v_changed boolean;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  if p_enabled is null then
    return private.rpc_error_envelope('22023', 'INVALID_REQUEST');
  end if;
  begin
    -- Exclusive catalogue lock drains in-flight starts/content mutations and
    -- makes the maintenance transition a hard boundary for subsequent work.
    perform pg_advisory_xact_lock(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    select * into v_state
    from private.course_catalog_runtime_state state
    where state.singleton
    for update;
    v_changed := v_state.maintenance_enabled is distinct from p_enabled;
    if v_changed then
      update private.course_catalog_runtime_state
      set maintenance_enabled = p_enabled,
          updated_by = v_actor_id,
          updated_at = statement_timestamp()
      where singleton
      returning * into v_state;
      insert into public.admin_audit_log(
        actor_user_id, action, target_type, target_id, after_data
      ) values (
        v_actor_id,
        case when p_enabled
          then 'catalog.maintenance_enabled'
          else 'catalog.maintenance_disabled'
        end,
        'course_catalog', 'singleton',
        jsonb_build_object('enabled', p_enabled)
      );
    end if;
    return private.ensure_rpc_payload(jsonb_build_object(
      'enabled', v_state.maintenance_enabled,
      'updatedAt', v_state.updated_at,
      'changed', v_changed
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.get_course_catalog_maintenance(uuid),
  public.set_course_catalog_maintenance(uuid,boolean)
from public, anon, authenticated, service_role;
grant execute on function public.get_course_catalog_maintenance(uuid),
  public.set_course_catalog_maintenance(uuid,boolean)
to authenticated;

create function public.finalize_course_presentation_metadata(
  p_actor_id uuid,
  p_course_id uuid,
  p_presentation_id uuid,
  p_expected_sha256 text,
  p_expected_page_count integer,
  p_expected_byte_size bigint,
  p_expected_staging_pdf_path text,
  p_expected_staging_thumbnail_path text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_presentation public.course_presentations%rowtype;
  v_cleanup public.course_presentations%rowtype;
  v_sha256 text := lower(coalesce(p_expected_sha256, ''));
  v_public_pdf_path text;
  v_public_thumbnail_path text;
  v_staging_prefix text;
  v_now timestamptz := statement_timestamp();
begin
  begin
    if not private.actor_has_capability(p_actor_id, 'test.manage') then
      raise exception using errcode = 'insufficient_privilege', message = 'FORBIDDEN';
    end if;
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    if private.course_catalog_maintenance_enabled() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_CATALOG_MAINTENANCE';
    end if;
    if p_course_id is null or p_presentation_id is null
      or v_sha256 !~ '^[0-9a-f]{64}$'
      or p_expected_page_count not between 1 and 200
      or p_expected_byte_size not between 1 and 26214400
      or char_length(coalesce(p_expected_staging_pdf_path, '')) not between 1 and 1024
      or char_length(coalesce(p_expected_staging_thumbnail_path, '')) not between 1 and 1024 then
      raise exception using errcode = 'invalid_parameter_value',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;
    v_staging_prefix := regexp_replace(
      p_expected_staging_pdf_path, '/source[.]pdf$', ''
    );
    if v_staging_prefix = p_expected_staging_pdf_path
      or p_expected_staging_thumbnail_path
        is distinct from v_staging_prefix || '/thumbnail.webp'
      or p_expected_staging_pdf_path
        !~ ('^' || p_actor_id::text
          || '/[0-9a-f-]{36}/source[.]pdf$') then
      raise exception using errcode = 'check_violation',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;

    v_public_pdf_path := p_course_id::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '.pdf';
    v_public_thumbnail_path := p_course_id::text || '/' || p_presentation_id::text
      || '/' || v_sha256 || '-thumb.webp';

    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = p_presentation_id
    for update;
    if not found
      or v_presentation.course_id is distinct from p_course_id
      or v_presentation.created_by is distinct from p_actor_id
      or v_presentation.sha256 is distinct from v_sha256
      or v_presentation.page_count is distinct from p_expected_page_count
      or v_presentation.byte_size is distinct from p_expected_byte_size then
      raise exception using errcode = 'check_violation',
        message = 'PRESENTATION_VALIDATION_FAILED';
    end if;
    if not exists (
      select 1 from public.tests test
      join public.course_drafts draft on draft.test_id = test.id
      where test.id = p_course_id
    ) then
      raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
    end if;

    if v_presentation.status = 'ready' then
      if v_presentation.storage_bucket <> 'course-presentations'
        or v_presentation.storage_path <> v_public_pdf_path
        or v_presentation.thumbnail_path <> v_public_thumbnail_path then
        raise exception using errcode = 'integrity_constraint_violation',
          message = 'PRESENTATION_VALIDATION_FAILED';
      end if;
      select * into v_cleanup
      from public.course_presentations cleanup
      where cleanup.storage_bucket = 'course-presentations-staging'
        and cleanup.storage_path = p_expected_staging_pdf_path
        and cleanup.status = 'retired'
      limit 1;
      return private.ensure_rpc_payload(jsonb_build_object(
        'presentation', jsonb_build_object(
          'id', v_presentation.id,
          'courseId', v_presentation.course_id,
          'storageBucket', v_presentation.storage_bucket,
          'storagePath', v_presentation.storage_path,
          'thumbnailPath', v_presentation.thumbnail_path,
          'sha256', v_presentation.sha256,
          'pageCount', v_presentation.page_count,
          'byteSize', v_presentation.byte_size,
          'status', v_presentation.status,
          'validatedAt', v_presentation.validated_at
        ),
        'cleanup', case when v_cleanup.id is null then null else jsonb_build_object(
          'id', v_cleanup.id,
          'bucket', v_cleanup.storage_bucket,
          'path', v_cleanup.storage_path,
          'thumbnailPath', v_cleanup.thumbnail_path,
          'leaseExpiresAt', v_cleanup.cleanup_claimed_at + interval '10 minutes'
        ) end,
        'replayed', true
      ));
    end if;

    if v_presentation.status <> 'validating'
      or v_presentation.storage_bucket <> 'course-presentations-staging'
      or v_presentation.storage_path <> p_expected_staging_pdf_path
      or v_presentation.thumbnail_path <> p_expected_staging_thumbnail_path then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'PRESENTATION_NOT_READY';
    end if;

    update public.course_presentations
    set storage_bucket = 'course-presentations',
        storage_path = v_public_pdf_path,
        thumbnail_path = v_public_thumbnail_path,
        status = 'ready',
        validation_error = null,
        validated_at = v_now,
        retired_at = null,
        cleanup_claimed_at = null
    where id = v_presentation.id
    returning * into v_presentation;

    insert into public.course_presentations(
      course_id, storage_bucket, storage_path, thumbnail_path,
      source_filename, mime_type, byte_size, sha256, page_count,
      aspect_ratio, status, created_by, created_at, retired_at,
      cleanup_claimed_at
    ) values (
      p_course_id, 'course-presentations-staging',
      p_expected_staging_pdf_path, p_expected_staging_thumbnail_path,
      v_presentation.source_filename, 'application/pdf',
      v_presentation.byte_size, v_presentation.sha256,
      v_presentation.page_count, v_presentation.aspect_ratio,
      'retired', p_actor_id, v_now, v_now, v_now
    ) returning * into v_cleanup;

    insert into public.admin_audit_log(
      actor_user_id, action, target_type, target_id, after_data
    ) values (
      p_actor_id, 'course.presentation_finalized', 'course_presentation',
      v_presentation.id::text,
      jsonb_build_object(
        'courseId', p_course_id,
        'sha256', v_presentation.sha256,
        'pageCount', v_presentation.page_count,
        'byteSize', v_presentation.byte_size,
        'cleanupId', v_cleanup.id
      )
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'presentation', jsonb_build_object(
        'id', v_presentation.id,
        'courseId', v_presentation.course_id,
        'storageBucket', v_presentation.storage_bucket,
        'storagePath', v_presentation.storage_path,
        'thumbnailPath', v_presentation.thumbnail_path,
        'sha256', v_presentation.sha256,
        'pageCount', v_presentation.page_count,
        'byteSize', v_presentation.byte_size,
        'status', v_presentation.status,
        'validatedAt', v_presentation.validated_at
      ),
      'cleanup', jsonb_build_object(
        'id', v_cleanup.id,
        'bucket', v_cleanup.storage_bucket,
        'path', v_cleanup.storage_path,
        'thumbnailPath', v_cleanup.thumbnail_path,
        'leaseExpiresAt', v_cleanup.cleanup_claimed_at + interval '10 minutes'
      ),
      'replayed', false
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.retire_course_presentation(
  p_actor_id uuid,
  p_course_id uuid,
  p_presentation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_presentation public.course_presentations%rowtype;
  v_now timestamptz := statement_timestamp();
  v_changed boolean := false;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  begin
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    if private.course_catalog_maintenance_enabled() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_CATALOG_MAINTENANCE';
    end if;
    select * into v_presentation
    from public.course_presentations presentation
    where presentation.id = p_presentation_id
      and presentation.course_id = p_course_id
    for update;
    if not found then
      raise exception using errcode = 'no_data_found', message = 'PRESENTATION_NOT_FOUND';
    end if;
    if exists (
      select 1 from public.course_drafts draft
      where draft.presentation_id = v_presentation.id
    ) or exists (
      select 1 from public.test_revisions revision
      where revision.presentation_id = v_presentation.id
    ) then
      raise exception using errcode = 'object_in_use', message = 'PRESENTATION_IN_USE';
    end if;
    if v_presentation.status <> 'retired' then
      update public.course_presentations
      set status = 'retired', retired_at = v_now, cleanup_claimed_at = null
      where id = v_presentation.id
      returning * into v_presentation;
      v_changed := true;
      insert into public.admin_audit_log(
        actor_user_id, action, target_type, target_id, after_data
      ) values (
        v_actor_id, 'course.presentation_retired', 'course_presentation',
        v_presentation.id::text,
        jsonb_build_object(
          'courseId', p_course_id,
          'storageBucket', v_presentation.storage_bucket,
          'sha256', v_presentation.sha256
        )
      );
    end if;
    return private.ensure_rpc_payload(jsonb_build_object(
      'presentationId', v_presentation.id,
      'courseId', p_course_id,
      'status', 'retired',
      'retiredAt', v_presentation.retired_at,
      'changed', v_changed
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.finalize_course_presentation_metadata(
  uuid,uuid,uuid,text,integer,bigint,text,text
), public.retire_course_presentation(uuid,uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.finalize_course_presentation_metadata(
  uuid,uuid,uuid,text,integer,bigint,text,text
) to service_role;
grant execute on function public.retire_course_presentation(uuid,uuid,uuid)
  to authenticated;

create or replace function private.attempt_payload(
  p_attempt_id uuid,
  p_retry_at timestamptz default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_key private.test_revision_variant_answer_keys%rowtype;
  v_certificate public.certificates%rowtype;
  v_questions jsonb := '[]'::jsonb;
  v_review jsonb := '[]'::jsonb;
begin
  select * into v_attempt from public.test_attempts where id = p_attempt_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'ATTEMPT_NOT_FOUND';
  end if;
  select * into v_revision from public.test_revisions where id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id and variant.revision_id = v_attempt.revision_id;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;
  if v_attempt.status = 'passed' then
    select * into v_key
    from private.test_revision_variant_answer_keys answer_key
    where answer_key.variant_id = v_attempt.variant_id;
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
      'correctOptionId', v_key.correct_option_ids ->> (question.ordinality::integer - 1),
      'isCorrect', question.value -> 'options'
        -> v_attempt.answers[question.ordinality::integer] ->> 'id'
          = v_key.correct_option_ids ->> (question.ordinality::integer - 1),
      'explanation', nullif(v_key.explanations ->> (question.ordinality::integer - 1), '')
    ) order by question.ordinality)
      filter (where v_attempt.status = 'passed'), '[]'::jsonb)
  into v_questions, v_review
  from jsonb_array_elements(v_variant.questions)
    with ordinality question(value, ordinality);

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'courseId', v_attempt.test_id,
    'revisionId', v_attempt.revision_id,
    'testSlug', v_revision.slug,
    'title', v_revision.title,
    'status', v_attempt.status,
    'score', v_attempt.score,
    'total', v_variant.question_count,
    'passScore', v_attempt.pass_score,
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
    'durationMinutes', v_attempt.duration_minutes,
    'startedAt', v_attempt.started_at,
    'expiresAt', v_attempt.expires_at,
    'serverNow', statement_timestamp(),
    'retryAt', p_retry_at,
    'questions', v_questions,
    'review', v_review
  );
end;
$$;

create or replace function private.start_test_attempt_unmetered(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_profile public.profiles%rowtype;
  v_test public.tests%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_attempt public.test_attempts%rowtype;
  v_count integer;
  v_local_date date;
  v_day_start timestamptz;
  v_retry_at timestamptz;
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if v_user_id is null then
    raise exception using errcode = 'insufficient_privilege', message = 'UNAUTHENTICATED';
  end if;
  -- Shared lock order for start/complete/history erase:
  -- catalogue lock -> user advisory lock -> profile/attempt row locks.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
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
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'PROFILE_ONBOARDING_REQUIRED';
  end if;
  if v_profile.avatar_updated_at is null then
    raise exception using errcode = 'object_not_in_prerequisite_state', message = 'AVATAR_REQUIRED';
  end if;
  if not private.has_current_legal_acceptance(v_user_id) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;

  select test.* into v_test
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  where test.slug = p_test_slug and test.status = 'published'
  for share of test;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_test.current_revision_id;

  -- The course-level lock additionally permits a strict per-course day count.
  perform pg_advisory_xact_lock(hashtextextended(
    v_user_id::text || ':' || v_test.id::text, 0
  ));
  update public.test_attempts
  set status = 'expired', completed_at = statement_timestamp()
  where user_id = v_user_id
    and test_id = v_test.id
    and status = 'started'
    and expires_at <= statement_timestamp();

  select * into v_attempt
  from public.test_attempts
  where user_id = v_user_id and test_id = v_test.id and status = 'started'
  order by started_at desc, id desc
  limit 1;
  if found then
    return private.attempt_payload(v_attempt.id);
  end if;

  -- Maintenance freezes only admission of a new attempt. Existing attempts
  -- have already returned above and completion remains available.
  if private.course_catalog_maintenance_enabled() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_CATALOG_MAINTENANCE';
  end if;

  v_local_date := (statement_timestamp()
    at time zone v_revision.attempt_reset_timezone)::date;
  v_day_start := v_local_date::timestamp
    at time zone v_revision.attempt_reset_timezone;
  v_retry_at := (v_local_date + 1)::timestamp
    at time zone v_revision.attempt_reset_timezone;

  select count(*) into v_count
  from public.test_attempts
  where user_id = v_user_id
    and test_id = v_test.id
    and started_at >= v_day_start
    and started_at < v_retry_at;
  if v_count >= v_revision.attempts_per_calendar_day then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_DAILY_LIMIT',
      detail = jsonb_build_object('retryAt', v_retry_at)::text;
  end if;

  perform private.ensure_legacy_revision_variant(v_revision.id);
  select * into v_variant
  from public.test_revision_variants variant
  where variant.revision_id = v_revision.id
  order by random()
  limit 1;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  insert into public.test_attempts (
    user_id, test_id, revision_id, variant_id, duration_minutes, pass_score,
    attempts_per_day, reset_timezone, expires_at
  ) values (
    v_user_id, v_test.id, v_revision.id, v_variant.id,
    v_revision.duration_minutes, v_revision.pass_score,
    v_revision.attempts_per_calendar_day, v_revision.attempt_reset_timezone,
    statement_timestamp() + make_interval(mins => v_revision.duration_minutes)
  ) returning * into v_attempt;

  return private.attempt_payload(v_attempt.id);
end;
$$;

create or replace function private.complete_test_attempt_unmetered(
  p_attempt_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_attempt public.test_attempts%rowtype;
  v_revision public.test_revisions%rowtype;
  v_variant public.test_revision_variants%rowtype;
  v_key private.test_revision_variant_answer_keys%rowtype;
  v_answers smallint[] := '{}'::smallint[];
  v_score integer := 0;
  v_matched_questions integer := 0;
  v_matched_options integer := 0;
  v_became_best boolean := false;
  v_attestation_id uuid;
  v_active_certificate public.certificates%rowtype;
  v_batch_id uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock_shared(hashtextextended(
    'safetyhub:course-catalog-activation', 0
  ));
  if jsonb_typeof(p_answers) is distinct from 'array' then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_ANSWERS';
  end if;
  if jsonb_array_length(p_answers) > 100 or pg_column_size(p_answers) > 65536 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'ATTEMPT_ANSWERS_TOO_LARGE';
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

  select * into v_revision
  from public.test_revisions where id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id
    and variant.revision_id = v_attempt.revision_id;
  select * into v_key
  from private.test_revision_variant_answer_keys answer_key
  where answer_key.variant_id = v_attempt.variant_id
    and answer_key.revision_id = v_attempt.revision_id;
  if v_variant.id is null or v_key.variant_id is null
    or jsonb_array_length(v_key.correct_option_ids) <> v_variant.question_count then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_VARIANT_INVALID';
  end if;

  if jsonb_array_length(p_answers) <> v_variant.question_count
    or (select count(distinct item ->> 'questionId')
        from jsonb_array_elements(p_answers) item)
      <> v_variant.question_count then
    raise exception using errcode = 'check_violation',
      message = 'DUPLICATE_OR_MISSING_QUESTION_ANSWER';
  end if;

  with submitted as (
    select item ->> 'questionId' as question_id,
      item ->> 'optionId' as option_id
    from jsonb_array_elements(p_answers) item
  ), matched as (
    select
      question.ordinality::integer as question_position,
      submitted.question_id,
      submitted.option_id,
      option.ordinality::integer - 1 as option_position
    from jsonb_array_elements(v_variant.questions)
      with ordinality question(value, ordinality)
    left join submitted on submitted.question_id = question.value ->> 'id'
    left join lateral (
      select candidate.ordinality
      from jsonb_array_elements(question.value -> 'options')
        with ordinality candidate(value, ordinality)
      where candidate.value ->> 'id' = submitted.option_id
      limit 1
    ) option on true
  )
  select
    coalesce(array_agg(
      matched.option_position::smallint order by matched.question_position
    ) filter (where matched.option_position is not null), '{}'::smallint[]),
    count(*) filter (
      where matched.option_id
        = v_key.correct_option_ids ->> (matched.question_position - 1)
    )::integer,
    count(matched.question_id)::integer,
    count(matched.option_position)::integer
  into v_answers, v_score, v_matched_questions, v_matched_options
  from matched;

  if v_matched_questions <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_QUESTION';
  end if;
  if v_matched_options <> v_variant.question_count then
    raise exception using errcode = 'check_violation', message = 'INVALID_ATTEMPT_OPTION';
  end if;

  update public.test_attempts
  set answers = v_answers,
      score = v_score,
      status = case
        when v_score >= v_attempt.pass_score then 'passed'::public.attempt_status
        else 'failed'::public.attempt_status
      end,
      completed_at = statement_timestamp()
  where id = v_attempt.id
  returning * into v_attempt;

  -- A failed result remains an attempt only. Attestations (and therefore any
  -- certificate workflow) begin exclusively at the passing threshold.
  if v_attempt.status <> 'passed' then
    return private.attempt_payload(v_attempt.id);
  end if;

  insert into public.attestations (
    user_id, revision_id, best_attempt_id, best_score, best_completed_at
  ) values (
    v_attempt.user_id, v_attempt.revision_id, v_attempt.id,
    v_attempt.score, v_attempt.completed_at
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
  returning id, best_attempt_id = v_attempt.id
  into v_attestation_id, v_became_best;

  if v_attestation_id is null then
    select id, best_attempt_id = v_attempt.id
    into v_attestation_id, v_became_best
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
        jsonb_build_object(
          'certificateNumber', v_active_certificate.certificate_number
        ),
        'Результат улучшен', v_batch_id
      );
      perform private.issue_certificate_for_attestation(
        v_attestation_id, null, 'score_improvement',
        v_active_certificate.id, v_batch_id
      );
    end if;
  end if;

  return private.attempt_payload(v_attempt.id);
end;
$$;

revoke all on function private.attempt_payload(uuid,timestamp with time zone),
  private.start_test_attempt_unmetered(text),
  private.complete_test_attempt_unmetered(uuid,jsonb),
  private.rpc_error_envelope(text,text,text)
from public, anon, authenticated, service_role;

-- A results.delete administrator needs a narrow target picker without being
-- granted the much broader user.read directory (capabilities, identity data,
-- organization and learning aggregates). Only participant accounts can ever
-- be returned because administrative/system accounts are forbidden targets.
create function public.list_learning_history_targets_page(
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

revoke all on function public.list_learning_history_targets_page(
  uuid,integer,text,timestamp with time zone,uuid
) from public, anon, authenticated, service_role;
grant execute on function public.list_learning_history_targets_page(
  uuid,integer,text,timestamp with time zone,uuid
) to authenticated;

create function public.get_admin_learning_history(
  p_actor_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- Preview is part of the destructive-history workflow and therefore uses
  -- the same explicit capability as the mutation. Requiring results.read as
  -- an additional, implicit permission would make results.delete unusable on
  -- its own and would diverge from the advertised capability contract.
  v_actor_id uuid := private.require_capability('results.delete');
  v_target_id uuid;
  v_name text;
  v_surname text;
  v_email text;
  v_role text;
  v_attempts integer;
  v_started integer;
  v_attestations integer;
  v_active_certificates integer;
  v_revoked_certificates integer;
  v_last_activity timestamptz;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  select profile.id, profile.name, profile.surname,
         auth_user.email::text, role.product_role::text
  into v_target_id, v_name, v_surname, v_email, v_role
  from public.profiles profile
  join auth.users auth_user on auth_user.id = profile.id
  join public.user_roles role on role.user_id = profile.id
  where profile.id = p_target_user_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  if v_role is distinct from 'participant' or p_target_user_id = v_actor_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'LEARNING_HISTORY_TARGET_NOT_ALLOWED';
  end if;

  select
    count(*)::integer,
    count(*) filter (where status = 'started')::integer,
    max(coalesce(completed_at, started_at))
  into v_attempts, v_started, v_last_activity
  from public.test_attempts
  where user_id = p_target_user_id;

  select count(*)::integer into v_attestations
  from public.attestations where user_id = p_target_user_id;
  select
    count(*) filter (where revoked_at is null)::integer,
    count(*) filter (where revoked_at is not null)::integer
  into v_active_certificates, v_revoked_certificates
  from public.certificates where user_id = p_target_user_id;

  return jsonb_build_object(
    'user', jsonb_build_object(
      'id', v_target_id,
      'name', v_name,
      'surname', v_surname,
      'email', v_email,
      'role', v_role
    ),
    'counts', jsonb_build_object(
      'attempts', coalesce(v_attempts, 0),
      'startedAttempts', coalesce(v_started, 0),
      'attestations', coalesce(v_attestations, 0),
      'activeCertificates', coalesce(v_active_certificates, 0),
      'revokedCertificates', coalesce(v_revoked_certificates, 0)
    ),
    'lastActivityAt', v_last_activity,
    'deletable', v_role = 'participant'
      and p_target_user_id <> v_actor_id
      and coalesce(v_attempts, 0) + coalesce(v_attestations, 0)
        + coalesce(v_active_certificates, 0)
        + coalesce(v_revoked_certificates, 0) > 0
  );
end;
$$;

create function private.delete_admin_learning_history_unmetered(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.delete');
  v_role text;
  v_reason text := btrim(coalesce(p_reason, ''));
  v_request_hash text;
  v_receipt private.learning_history_delete_receipts%rowtype;
  v_audit public.admin_audit_log%rowtype;
  v_attestation_ids uuid[] := '{}'::uuid[];
  v_export_jobs integer := 0;
  v_attempts integer := 0;
  v_started integer := 0;
  v_attestations integer := 0;
  v_active_certificates integer := 0;
  v_revoked_certificates integer := 0;
  v_result jsonb;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if p_target_user_id is null or p_idempotency_key is null
    or char_length(v_reason) not between 10 and 500 then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'LEARNING_HISTORY_DELETE_INVALID';
  end if;

  v_request_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'targetUserId', p_target_user_id,
    'reason', v_reason
  )::text, 'utf8'), 'sha256'), 'hex');

  perform pg_advisory_xact_lock(hashtextextended(
    v_actor_id::text || ':' || p_idempotency_key::text, 0
  ));
  select * into v_receipt
  from private.learning_history_delete_receipts receipt
  where receipt.actor_user_id = v_actor_id
    and receipt.idempotency_key = p_idempotency_key;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  -- The durable audit is the permanent idempotency ledger after short-lived
  -- receipts are pruned. This prevents a repeated destructive key from ever
  -- creating a second audit record.
  select * into v_audit
  from public.admin_audit_log audit
  where audit.actor_user_id = v_actor_id
    and audit.action = 'learning_history.deleted'
    and audit.batch_id = p_idempotency_key
  order by audit.created_at desc, audit.id desc
  limit 1;
  if found then
    if v_audit.target_user_id is distinct from p_target_user_id
      or btrim(coalesce(v_audit.reason, '')) <> v_reason then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object(
      'operationId', p_idempotency_key,
      'targetUserId', p_target_user_id,
      'deleted', coalesce((v_audit.after_data ->> 'attempts')::integer, 0)
        + coalesce((v_audit.after_data ->> 'attestations')::integer, 0)
        + coalesce((v_audit.after_data ->> 'activeCertificates')::integer, 0)
        + coalesce((v_audit.after_data ->> 'revokedCertificates')::integer, 0) > 0,
      'replayed', true,
      'counts', v_audit.after_data
    );
  end if;

  if p_target_user_id = v_actor_id then
    raise exception using errcode = 'insufficient_privilege',
      message = 'LEARNING_HISTORY_TARGET_NOT_ALLOWED';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_target_user_id::text, 0));
  perform 1 from public.profiles where id = p_target_user_id for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
  end if;
  select product_role::text into v_role
  from public.user_roles where user_id = p_target_user_id;
  if v_role is distinct from 'participant' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'LEARNING_HISTORY_TARGET_NOT_ALLOWED';
  end if;

  select
    count(*)::integer,
    count(*) filter (where status = 'started')::integer
  into v_attempts, v_started
  from public.test_attempts where user_id = p_target_user_id;
  select coalesce(array_agg(id), '{}'::uuid[]), count(*)::integer
  into v_attestation_ids, v_attestations
  from public.attestations where user_id = p_target_user_id;
  select
    count(*) filter (where revoked_at is null)::integer,
    count(*) filter (where revoked_at is not null)::integer
  into v_active_certificates, v_revoked_certificates
  from public.certificates where user_id = p_target_user_id;

  if coalesce(v_attempts, 0) + coalesce(v_attestations, 0)
      + coalesce(v_active_certificates, 0) + coalesce(v_revoked_certificates, 0) = 0 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEARNING_HISTORY_ALREADY_DELETED';
  end if;

  delete from private.certificate_export_jobs job
  where job.attestation_ids && v_attestation_ids;
  get diagnostics v_export_jobs = row_count;
  delete from public.certificates where user_id = p_target_user_id;
  delete from public.attestations where user_id = p_target_user_id;
  delete from public.test_attempts where user_id = p_target_user_id;

  if not exists (select 1 from public.profiles where id = p_target_user_id)
    or not exists (select 1 from auth.users where id = p_target_user_id) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'LEARNING_HISTORY_ACCOUNT_PRESERVATION_FAILED';
  end if;

  v_result := jsonb_build_object(
    'operationId', p_idempotency_key,
    'targetUserId', p_target_user_id,
    'deleted', (coalesce(v_attempts, 0) + coalesce(v_attestations, 0)
      + coalesce(v_active_certificates, 0) + coalesce(v_revoked_certificates, 0)) > 0,
    'replayed', false,
    'counts', jsonb_build_object(
      'attempts', coalesce(v_attempts, 0),
      'startedAttempts', coalesce(v_started, 0),
      'attestations', coalesce(v_attestations, 0),
      'activeCertificates', coalesce(v_active_certificates, 0),
      'revokedCertificates', coalesce(v_revoked_certificates, 0),
      'certificateExportJobs', coalesce(v_export_jobs, 0)
    )
  );

  insert into private.learning_history_delete_receipts(
    actor_user_id, idempotency_key, target_user_id, request_hash, result
  ) values (
    v_actor_id, p_idempotency_key, p_target_user_id, v_request_hash, v_result
  );

  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, reason, batch_id
  ) values (
    v_actor_id, p_target_user_id, 'learning_history.deleted', 'user_learning_history',
    p_target_user_id::text, v_result -> 'counts', v_reason, p_idempotency_key
  );

  return v_result;
end;
$$;

create function public.delete_admin_learning_history(
  p_actor_id uuid,
  p_target_user_id uuid,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  begin
    v_result := private.delete_admin_learning_history_unmetered(
      p_actor_id, p_target_user_id, p_reason, p_idempotency_key
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function public.prune_learning_history_delete_receipts(
  p_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  with expired as (
    select actor_user_id, idempotency_key
    from private.learning_history_delete_receipts
    where expires_at < statement_timestamp()
    order by expires_at
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
    for update skip locked
  )
  delete from private.learning_history_delete_receipts receipt
  using expired
  where receipt.actor_user_id = expired.actor_user_id
    and receipt.idempotency_key = expired.idempotency_key;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.get_admin_learning_history(uuid,uuid),
  public.delete_admin_learning_history(uuid,uuid,text,uuid),
  public.prune_learning_history_delete_receipts(integer)
from public, anon, authenticated, service_role;
grant execute on function public.get_admin_learning_history(uuid,uuid)
  to authenticated;
grant execute on function public.delete_admin_learning_history(uuid,uuid,text,uuid)
  to authenticated;
grant execute on function public.prune_learning_history_delete_receipts(integer)
  to service_role;
revoke all on function private.delete_admin_learning_history_unmetered(uuid,uuid,text,uuid)
  from public, anon, authenticated, service_role;

create function public.prepare_course_catalog_batch(
  p_actor_id uuid,
  p_test_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_batch_id uuid;
  v_slug_set text[];
  v_valid_count integer;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    return private.rpc_error_envelope('42501', 'ACTOR_MISMATCH');
  end if;
  begin
    perform pg_advisory_xact_lock_shared(hashtextextended(
      'safetyhub:course-catalog-activation', 0
    ));
    if private.course_catalog_maintenance_enabled() then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'COURSE_CATALOG_MAINTENANCE';
    end if;
    if cardinality(p_test_ids) <> 5
      or (select count(distinct id) from unnest(p_test_ids) id) <> 5 then
      raise exception using errcode = 'check_violation',
        message = 'CATALOG_BATCH_INVALID';
    end if;

    select array_agg(draft.slug order by draft.slug),
      count(*) filter (
        where draft.display_order between 1 and 5
          and test.status = 'draft'
          and test.current_revision_id is null
          and test.content_version = 0
          and draft.title = case draft.slug
            when 'plotnik' then 'Плотник'
            when 'armaturshchik' then 'Арматурщик'
            when 'lesomontazhnye-raboty' then 'Лесомонтажные работы'
            when 'biot' then 'БИОТ'
            when 'pozharnaya-bezopasnost' then 'Пожарная безопасность'
          end
          and draft.display_order = case draft.slug
            when 'plotnik' then 1
            when 'armaturshchik' then 2
            when 'lesomontazhnye-raboty' then 3
            when 'biot' then 4
            when 'pozharnaya-bezopasnost' then 5
          end
          and presentation.page_count = case draft.slug
            when 'plotnik' then 25
            when 'armaturshchik' then 31
            when 'lesomontazhnye-raboty' then 42
            when 'biot' then 59
            when 'pozharnaya-bezopasnost' then 41
          end
          and draft.duration_minutes = 15
          and draft.pass_score = 7
          and draft.attempts_per_calendar_day = 8
          and draft.attempt_reset_timezone = 'Asia/Oral'
          and private.course_question_variants_valid(draft.question_variants)
          and presentation.id is not null
          and presentation.course_id = draft.test_id
          and presentation.status = 'ready'
      )::integer
    into v_slug_set, v_valid_count
    from public.course_drafts draft
    join public.tests test on test.id = draft.test_id
    left join public.course_presentations presentation
      on presentation.id = draft.presentation_id
    where draft.test_id = any(p_test_ids);

    if v_slug_set is distinct from array[
      'armaturshchik', 'biot', 'lesomontazhnye-raboty',
      'plotnik', 'pozharnaya-bezopasnost'
    ]::text[] or v_valid_count <> 5 then
      raise exception using errcode = 'check_violation',
        message = 'CATALOG_BATCH_INVALID';
    end if;
    if (
      select count(distinct display_order)
      from public.course_drafts where test_id = any(p_test_ids)
    ) <> 5 then
      raise exception using errcode = 'check_violation',
        message = 'CATALOG_BATCH_INVALID';
    end if;

    insert into public.course_catalog_batches(status, created_by)
    values ('staging', v_actor_id)
    returning id into v_batch_id;
    insert into public.course_catalog_batch_items(
      batch_id, test_id, display_order, expected_content_hash
    )
    select v_batch_id, draft.test_id, draft.display_order, draft.content_hash
    from public.course_drafts draft
    where draft.test_id = any(p_test_ids)
    order by draft.display_order;

    insert into public.admin_audit_log(
      actor_user_id, action, target_type, target_id, after_data, batch_id
    ) values (
      v_actor_id, 'catalog.batch_prepared', 'course_catalog_batch',
      v_batch_id::text, jsonb_build_object('courseCount', 5), v_batch_id
    );

    return private.ensure_rpc_payload(jsonb_build_object(
      'batchId', v_batch_id,
      'status', 'staging',
      'courseCount', 5
    ));
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create function private.activate_course_catalog_batch_unmetered(
  p_actor_id uuid,
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_batch public.course_catalog_batches%rowtype;
  v_item record;
  v_kept_test_ids uuid[];
  v_old_test_ids uuid[] := '{}'::uuid[];
  v_old_asset_ids uuid[] := '{}'::uuid[];
  v_old_presentation_ids uuid[] := '{}'::uuid[];
  v_auth_count_before integer;
  v_auth_count_after integer;
  v_profile_count_before integer;
  v_profile_count_after integer;
  v_auth_hash_before text;
  v_auth_hash_after text;
  v_profile_hash_before text;
  v_profile_hash_after text;
  v_deleted_export_jobs integer := 0;
  v_deleted_certificates integer := 0;
  v_deleted_attestations integer := 0;
  v_deleted_attempts integer := 0;
  v_deleted_courses integer := 0;
  v_published_courses integer;
  v_published_revisions integer;
  v_published_variants integer;
  v_published_questions integer;
  v_published_options integer;
  v_catalog_checksum text;
  v_result jsonb;
begin
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if p_batch_id is null or p_idempotency_key is null then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'CATALOG_ACTIVATION_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('safetyhub:course-catalog-activation', 0));
  select * into v_batch
  from public.course_catalog_batches batch
  where batch.id = p_batch_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'CATALOG_BATCH_NOT_FOUND';
  end if;
  if v_batch.status = 'activated' then
    if v_batch.activation_idempotency_key is distinct from p_idempotency_key then
      raise exception using errcode = 'integrity_constraint_violation',
        message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return v_batch.result || jsonb_build_object('replayed', true);
  end if;
  if v_batch.status <> 'staging' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CATALOG_BATCH_NOT_STAGING';
  end if;
  if not private.course_catalog_maintenance_enabled() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CATALOG_MAINTENANCE_REQUIRED';
  end if;

  select array_agg(item.test_id order by item.display_order)
  into v_kept_test_ids
  from public.course_catalog_batch_items item
  join public.course_drafts draft on draft.test_id = item.test_id
  join public.tests test on test.id = item.test_id
  join public.course_presentations presentation
    on presentation.id = draft.presentation_id
  where item.batch_id = p_batch_id
    and item.expected_content_hash = draft.content_hash
    and item.display_order = draft.display_order
    and test.status = 'draft'
    and test.current_revision_id is null
    and test.content_version = 0
    and draft.title = case draft.slug
      when 'plotnik' then 'Плотник'
      when 'armaturshchik' then 'Арматурщик'
      when 'lesomontazhnye-raboty' then 'Лесомонтажные работы'
      when 'biot' then 'БИОТ'
      when 'pozharnaya-bezopasnost' then 'Пожарная безопасность'
    end
    and draft.display_order = case draft.slug
      when 'plotnik' then 1
      when 'armaturshchik' then 2
      when 'lesomontazhnye-raboty' then 3
      when 'biot' then 4
      when 'pozharnaya-bezopasnost' then 5
    end
    and presentation.page_count = case draft.slug
      when 'plotnik' then 25
      when 'armaturshchik' then 31
      when 'lesomontazhnye-raboty' then 42
      when 'biot' then 59
      when 'pozharnaya-bezopasnost' then 41
    end
    and draft.duration_minutes = 15
    and draft.pass_score = 7
    and draft.attempts_per_calendar_day = 8
    and draft.attempt_reset_timezone = 'Asia/Oral'
    and private.course_question_variants_valid(draft.question_variants)
    and presentation.course_id = draft.test_id
    and presentation.status = 'ready';
  if cardinality(v_kept_test_ids) <> 5 then
    raise exception using errcode = 'serialization_failure',
      message = 'CATALOG_BATCH_CONFLICT';
  end if;
  if (
    select array_agg(draft.slug order by draft.slug)
    from public.course_drafts draft where draft.test_id = any(v_kept_test_ids)
  ) is distinct from array[
    'armaturshchik', 'biot', 'lesomontazhnye-raboty',
    'plotnik', 'pozharnaya-bezopasnost'
  ]::text[] then
    raise exception using errcode = 'check_violation',
      message = 'CATALOG_BATCH_INVALID';
  end if;

  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(
      string_agg(id::text, ',' order by id::text), ''
    ), 'utf8'), 'sha256'), 'hex')
  into v_auth_count_before, v_auth_hash_before
  from auth.users;
  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(
      string_agg(id::text, ',' order by id::text), ''
    ), 'utf8'), 'sha256'), 'hex')
  into v_profile_count_before, v_profile_hash_before
  from public.profiles;

  select coalesce(array_agg(id), '{}'::uuid[])
  into v_old_test_ids
  from public.tests where not (id = any(v_kept_test_ids));
  select coalesce(array_agg(distinct usage.asset_id), '{}'::uuid[])
  into v_old_asset_ids
  from public.content_asset_usages usage
  where usage.owner_id = any(v_old_test_ids)
    and usage.owner_type in ('course_draft', 'course_revision');
  select coalesce(array_agg(id), '{}'::uuid[])
  into v_old_presentation_ids
  from public.course_presentations
  where course_id = any(v_old_test_ids);

  perform set_config('safetyhub.catalog_activation', '1', true);
  perform set_config('safetyhub.content_delete', '1', true);

  delete from private.certificate_export_jobs;
  get diagnostics v_deleted_export_jobs = row_count;
  delete from public.certificates;
  get diagnostics v_deleted_certificates = row_count;
  delete from public.attestations;
  get diagnostics v_deleted_attestations = row_count;
  delete from public.test_attempts;
  get diagnostics v_deleted_attempts = row_count;
  delete from public.content_asset_usages
  where owner_id = any(v_old_test_ids)
    and owner_type in ('course_draft', 'course_revision');
  -- Retire ready objects before ON DELETE SET NULL clears course_id; the ready
  -- state deliberately requires a live owning course.
  update public.course_presentations
  set status = 'retired', retired_at = statement_timestamp()
  where id = any(v_old_presentation_ids) and status <> 'retired';
  delete from public.tests where id = any(v_old_test_ids);
  get diagnostics v_deleted_courses = row_count;

  update public.content_assets asset
  set status = 'orphan_candidate'
  where asset.id = any(v_old_asset_ids)
    and not exists (
      select 1 from public.content_asset_usages usage where usage.asset_id = asset.id
    );
  for v_item in
    select item.test_id, item.expected_content_hash
    from public.course_catalog_batch_items item
    where item.batch_id = p_batch_id
    order by item.display_order
  loop
    perform private.publish_course_revision_v3_unmetered(
      v_actor_id, v_item.test_id, v_item.expected_content_hash
    );
    perform public.get_published_course_snapshot_v3(v_item.test_id);
  end loop;

  insert into public.course_slug_redirects(old_slug, test_id)
  select redirect.old_slug, test.id
  from (values
    ('fire-safety', 'pozharnaya-bezopasnost'),
    ('occupational-health', 'biot')
  ) redirect(old_slug, new_slug)
  join public.tests test on test.slug = redirect.new_slug
  on conflict (old_slug) do update set test_id = excluded.test_id;

  select count(*)::integer into v_published_courses
  from public.tests where status = 'published';
  select count(*)::integer into v_published_revisions
  from public.test_revisions revision
  join public.tests test on test.current_revision_id = revision.id
  where test.status = 'published';
  select count(*)::integer, coalesce(sum(variant.question_count), 0)::integer
  into v_published_variants, v_published_questions
  from public.test_revision_variants variant
  join public.tests test on test.current_revision_id = variant.revision_id
  where test.status = 'published';
  select count(*)::integer into v_published_options
  from public.test_revision_variants variant
  join public.tests test on test.current_revision_id = variant.revision_id
  cross join lateral jsonb_array_elements(variant.questions) question
  cross join lateral jsonb_array_elements(question -> 'options') option
  where test.status = 'published';

  if (v_published_courses, v_published_revisions, v_published_variants,
      v_published_questions, v_published_options)
    is distinct from (5, 5, 15, 150, 600) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'CATALOG_ACTIVATION_POSTCONDITION_FAILED';
  end if;
  if exists (select 1 from public.test_attempts)
    or exists (select 1 from public.attestations)
    or exists (select 1 from public.certificates) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'CATALOG_HISTORY_WIPE_FAILED';
  end if;

  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(
      string_agg(id::text, ',' order by id::text), ''
    ), 'utf8'), 'sha256'), 'hex')
  into v_auth_count_after, v_auth_hash_after
  from auth.users;
  select count(*)::integer,
    encode(extensions.digest(convert_to(coalesce(
      string_agg(id::text, ',' order by id::text), ''
    ), 'utf8'), 'sha256'), 'hex')
  into v_profile_count_after, v_profile_hash_after
  from public.profiles;
  if (v_auth_count_before, v_auth_hash_before, v_profile_count_before, v_profile_hash_before)
    is distinct from
      (v_auth_count_after, v_auth_hash_after, v_profile_count_after, v_profile_hash_after) then
    raise exception using errcode = 'integrity_constraint_violation',
      message = 'CATALOG_ACCOUNT_PRESERVATION_FAILED';
  end if;

  select encode(extensions.digest(convert_to(string_agg(
    revision.content_hash, ',' order by revision.display_order
  ), 'utf8'), 'sha256'), 'hex')
  into v_catalog_checksum
  from public.tests test
  join public.test_revisions revision on revision.id = test.current_revision_id
  where test.status = 'published';

  v_result := jsonb_build_object(
    'batchId', p_batch_id,
    'activationId', p_idempotency_key,
    'status', 'activated',
    'replayed', false,
    'maintenanceEnabled', true,
    'catalogChecksum', v_catalog_checksum,
    'published', jsonb_build_object(
      'courses', v_published_courses,
      'revisions', v_published_revisions,
      'variants', v_published_variants,
      'questions', v_published_questions,
      'options', v_published_options
    ),
    'deleted', jsonb_build_object(
      'courses', v_deleted_courses,
      'attempts', v_deleted_attempts,
      'attestations', v_deleted_attestations,
      'certificates', v_deleted_certificates,
      'certificateExportJobs', v_deleted_export_jobs
    ),
    'preserved', jsonb_build_object(
      'authUsers', v_auth_count_after,
      'profiles', v_profile_count_after
    )
  );

  update public.course_catalog_batches
  set status = 'activated',
      activation_idempotency_key = p_idempotency_key,
      result = v_result,
      activated_at = statement_timestamp()
  where id = p_batch_id;

  insert into public.admin_audit_log(
    actor_user_id, action, target_type, target_id,
    after_data, batch_id
  ) values (
    v_actor_id, 'catalog.replaced', 'course_catalog_batch', p_batch_id::text,
    jsonb_build_object(
      'catalogChecksum', v_catalog_checksum,
      'published', v_result -> 'published',
      'deleted', v_result -> 'deleted',
      'preserved', v_result -> 'preserved'
    ), p_batch_id
  );

  return v_result;
end;
$$;

create function public.activate_course_catalog_batch(
  p_actor_id uuid,
  p_batch_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    v_result := private.activate_course_catalog_batch_unmetered(
      p_actor_id, p_batch_id, p_idempotency_key
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

revoke all on function public.prepare_course_catalog_batch(uuid,uuid[]),
  public.activate_course_catalog_batch(uuid,uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.prepare_course_catalog_batch(uuid,uuid[])
  to authenticated;
grant execute on function public.activate_course_catalog_batch(uuid,uuid,uuid)
  to authenticated;
revoke all on function private.activate_course_catalog_batch_unmetered(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

-- The rolling Stage-A deployment must keep the v2 editor callable until the
-- atomic activation commits. After that boundary, stale application instances
-- must not be able to publish a presentation-less one-variant revision. Keep
-- the legacy grants for Stage A, but make their mutation wrappers fail closed
-- once any v3 catalogue batch has reached the activated state.
create function private.course_catalog_v3_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.course_catalog_batches batch
    where batch.status = 'activated'
  );
$$;

create function private.assert_legacy_course_mutation_allowed()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.course_catalog_v3_active() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'COURSE_EDITOR_VERSION_RETIRED';
  end if;
end;
$$;

revoke all on function private.course_catalog_v3_active(),
  private.assert_legacy_course_mutation_allowed()
from public, anon, authenticated, service_role;

create or replace function public.save_course_draft_v2(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    perform private.assert_legacy_course_mutation_allowed();
    v_result := private.save_course_draft_v2_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
      p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.save_course_draft(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.save_course_draft_v2(
    p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
    p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
  );
$$;

create or replace function public.publish_course_revision_v2(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('test.manage');
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  begin
    perform private.assert_legacy_course_mutation_allowed();
    v_result := private.publish_course_revision_v2_unmetered(
      v_actor_id, p_test_id, p_expected_content_hash
    );
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

create or replace function public.publish_course_revision(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_content_hash text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.publish_course_revision_v2(
    p_actor_id, p_test_id, p_expected_content_hash
  );
$$;

create or replace function public.save_and_publish_course_v2(
  p_actor_id uuid,
  p_test_id uuid,
  p_expected_version bigint,
  p_slug text,
  p_title text,
  p_description text,
  p_icon text,
  p_duration_minutes integer,
  p_content jsonb,
  p_questions jsonb,
  p_seo jsonb,
  p_content_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_saved jsonb;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  begin
    perform private.assert_legacy_course_mutation_allowed();
    v_saved := private.save_course_draft_v2_unmetered(
      p_actor_id, p_test_id, p_expected_version, p_slug, p_title, p_description,
      p_icon, p_duration_minutes, p_content, p_questions, p_seo, p_content_metadata
    );
    v_result := private.publish_course_revision_v2_unmetered(
      p_actor_id,
      (v_saved ->> 'id')::uuid,
      v_saved ->> 'contentHash'
    );
    return private.ensure_rpc_payload(
      v_result || jsonb_build_object(
        'draftVersion', (v_saved ->> 'draftVersion')::bigint
      )
    );
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- Status changes remain a supported v3 operation. Publishing after the cutover
-- must use the strict v3 publisher; before activation it keeps the rolling
-- deployment's compatibility behavior.
create or replace function public.set_test_status(
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
  v_draft public.course_drafts%rowtype;
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  if p_actor_id is distinct from v_actor_id then
    raise exception using errcode = 'insufficient_privilege', message = 'ACTOR_MISMATCH';
  end if;
  if p_status not in ('draft', 'published') then
    raise exception using errcode = 'check_violation', message = 'TEST_STATUS_INVALID';
  end if;
  begin
    if p_status = 'published' then
      select * into v_draft from public.course_drafts where test_id = p_test_id;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'COURSE_DRAFT_NOT_FOUND';
      end if;
      if private.course_catalog_v3_active() then
        v_result := private.publish_course_revision_v3_unmetered(
          v_actor_id, p_test_id, v_draft.content_hash
        );
      else
        v_result := private.publish_course_revision_v2_unmetered(
          v_actor_id, p_test_id, v_draft.content_hash
        );
      end if;
    else
      update public.tests
      set status = 'draft', updated_by = v_actor_id
      where id = p_test_id
      returning * into v_test;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'TEST_NOT_FOUND';
      end if;
      insert into public.admin_audit_log (
        actor_user_id, action, target_type, target_id, after_data
      ) values (
        v_actor_id, 'test.status_changed', 'test', p_test_id::text,
        jsonb_build_object('status', 'draft')
      );
      v_result := jsonb_build_object(
        'id', v_test.id, 'slug', v_test.slug, 'status', 'draft'
      );
    end if;
    return private.ensure_rpc_payload(v_result);
  exception when others then
    return private.rpc_error_envelope(sqlstate, sqlerrm);
  end;
end;
$$;

-- No current application surface uses this v2 hash-mutating shortcut. Revoke
-- it at the additive migration boundary so it cannot corrupt a v3 draft hash.
revoke execute on function public.change_course_slug(uuid,uuid,bigint,text)
  from authenticated, service_role;
