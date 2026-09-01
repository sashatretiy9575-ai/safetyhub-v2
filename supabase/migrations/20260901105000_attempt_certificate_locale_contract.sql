-- Pin every attempt and certificate to an immutable learner locale. Learner
-- attempt payloads remain answer-key-free and never reveal variant identity.

alter table public.test_attempts
  add column locale public.app_locale not null default 'ru';

create index test_attempts_user_course_locale_started_idx
  on public.test_attempts (user_id, test_id, locale, started_at desc, id desc);

create function private.set_attempt_locale_on_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_requested text := nullif(
    current_setting('safetyhub.request_locale', true),
    ''
  );
begin
  -- Only the locale-aware RPC may select a non-RU attempt locale. Direct
  -- privileged inserts are retained for operational/legacy compatibility,
  -- but they cannot trust a caller-supplied row value and are pinned to RU.
  -- Browser roles have no INSERT grant on the attempts table.
  if v_requested is null then
    new.locale := 'ru'::public.app_locale;
    return new;
  end if;

  new.locale := v_requested::public.app_locale;
  if not exists (
    select 1
    from public.test_revision_localizations localization
    join public.test_revision_variant_localizations variant_localization
      on variant_localization.revision_id = localization.revision_id
     and variant_localization.variant_id = new.variant_id
      and variant_localization.locale = localization.locale
    where localization.revision_id = new.revision_id
      and localization.locale = new.locale
  ) then
    -- Every application RPC supplies request_locale, so a missing requested
    -- revision/variant localization remains fail-closed.
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_LOCALIZATION_NOT_FOUND';
  end if;
  return new;
end;
$$;

create trigger test_attempts_pin_locale
before insert on public.test_attempts
for each row execute function private.set_attempt_locale_on_insert();

create function private.protect_attempt_locale()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.locale is distinct from old.locale then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_LOCALE_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger test_attempts_locale_immutable
before update on public.test_attempts
for each row execute function private.protect_attempt_locale();

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
  v_localization public.test_revision_localizations%rowtype;
  v_variant_localization public.test_revision_variant_localizations%rowtype;
  v_certificate public.certificates%rowtype;
  v_questions jsonb := '[]'::jsonb;
begin
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = p_attempt_id;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'ATTEMPT_NOT_FOUND';
  end if;

  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_attempt.revision_id;
  select * into v_variant
  from public.test_revision_variants variant
  where variant.id = v_attempt.variant_id
    and variant.revision_id = v_attempt.revision_id;
  select * into v_localization
  from public.test_revision_localizations localization
  where localization.revision_id = v_attempt.revision_id
    and localization.locale = v_attempt.locale;
  select * into v_variant_localization
  from public.test_revision_variant_localizations localization
  where localization.revision_id = v_attempt.revision_id
    and localization.variant_id = v_attempt.variant_id
    and localization.locale = v_attempt.locale;
  if v_revision.id is null
    or v_variant.id is null
    or v_localization.revision_id is null
    or v_variant_localization.variant_id is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTEMPT_LOCALIZATION_NOT_FOUND';
  end if;

  select * into v_certificate
  from public.certificates certificate
  where certificate.user_id = v_attempt.user_id
    and certificate.revision_id = v_attempt.revision_id
    and certificate.revoked_at is null
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
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
  ) order by question.ordinality), '[]'::jsonb)
  into v_questions
  from jsonb_array_elements(
    private.localized_public_questions(v_variant_localization.questions)
  )
    with ordinality question(value, ordinality);

  return jsonb_build_object(
    'attemptId', v_attempt.id,
    'courseId', v_attempt.test_id,
    'revisionId', v_attempt.revision_id,
    'testSlug', v_revision.slug,
    'locale', v_attempt.locale,
    'title', v_localization.title,
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
    'questions', v_questions
  );
end;
$$;

create function public.start_test_attempt_locale(
  p_test_slug text,
  p_locale public.app_locale
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_detail text;
begin
  perform private.require_approved_learner();
  perform private.enforce_actor_quota('attempt.start');
  begin
    perform set_config('safetyhub.request_locale', p_locale::text, true);
    v_result := private.start_test_attempt_unmetered(p_test_slug);
    return private.ensure_rpc_payload(v_result);
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return private.rpc_error_envelope(sqlstate, sqlerrm, v_detail);
  end;
end;
$$;

create or replace function public.start_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_approved_learner();
  v_locale public.app_locale;
begin
  select profile.preferred_locale into v_locale
  from public.profiles profile
  where profile.id = v_user_id;
  return public.start_test_attempt_locale(
    p_test_slug,
    coalesce(v_locale, 'ru'::public.app_locale)
  );
end;
$$;

alter table public.certificates
  add column locale public.app_locale not null default 'ru',
  add column localized_test_title text;

-- The previous snapshot guard correctly rejects all metadata changes. Disable
-- it only while this migration backfills the two newly-added snapshot columns;
-- the migration's table lock prevents an unguarded application-write window.
alter table public.certificates disable trigger certificates_snapshot_guard;

update public.certificates certificate
set locale = coalesce(attempt.locale, 'ru'::public.app_locale),
    localized_test_title = coalesce(
      localization.title,
      certificate.test_title
    )
from public.test_attempts attempt
left join public.test_revision_localizations localization
  on localization.revision_id = attempt.revision_id
 and localization.locale = attempt.locale
where attempt.id = certificate.attempt_id;

update public.certificates
set localized_test_title = test_title
where localized_test_title is null;

alter table public.certificates enable trigger certificates_snapshot_guard;

alter table public.certificates
  alter column localized_test_title set not null,
  add constraint certificate_localized_title_budget
    check (char_length(localized_test_title) between 1 and 200);

create index certificates_locale_issued_idx
  on public.certificates (locale, issued_at desc, id desc);

create or replace function private.guard_certificate_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attestation public.attestations%rowtype;
  v_revision public.test_revisions%rowtype;
  v_attempt public.test_attempts%rowtype;
  v_localization public.test_revision_localizations%rowtype;
  v_identity public.verified_identities%rowtype;
  v_predecessor public.certificates%rowtype;
  v_expected_name text;
  v_purge_actor text := coalesce(
    current_setting('safetyhub.purge_actor_id', true),
    ''
  );
  v_content_delete text := coalesce(
    current_setting('safetyhub.content_delete', true),
    ''
  );
begin
  if tg_op = 'UPDATE' then
    if v_content_delete = '1'
      and old.course_deleted_at is null
      and new.course_deleted_at is not null
      and new.revision_id is null
      and new.attestation_id is null
      and new.attempt_id is null
      and to_jsonb(new)
        - array['revision_id','attestation_id','attempt_id','course_deleted_at']
        = to_jsonb(old)
        - array['revision_id','attestation_id','attempt_id','course_deleted_at'] then
      return new;
    end if;
    if v_purge_actor <> ''
      and to_jsonb(new) - array['issued_by','revoked_by']
        = to_jsonb(old) - array['issued_by','revoked_by']
      and new.issued_by is not distinct from (
        case when old.issued_by::text = v_purge_actor
          then null else old.issued_by end
      )
      and new.revoked_by is not distinct from (
        case when old.revoked_by::text = v_purge_actor
          then null else old.revoked_by end
      ) then
      return new;
    end if;
    if to_jsonb(new) - array['revoked_at','revoked_by','revoke_reason']
      is distinct from
      to_jsonb(old) - array['revoked_at','revoked_by','revoke_reason'] then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_SNAPSHOT_IMMUTABLE';
    end if;
    if old.revoked_at is not null
      and (new.revoked_at, new.revoked_by, new.revoke_reason)
        is distinct from
        (old.revoked_at, old.revoked_by, old.revoke_reason) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'CERTIFICATE_REVOCATION_IMMUTABLE';
    end if;
    if new.revoked_at is null
      and (new.revoked_by is not null or new.revoke_reason is not null) then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_REVOCATION_INVALID';
    end if;
    if new.revoked_at is not null
      and char_length(coalesce(new.revoke_reason, '')) < 3 then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_REVOKE_REASON_REQUIRED';
    end if;
    return new;
  end if;

  select * into v_attestation
  from public.attestations attestation
  where attestation.id = new.attestation_id;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = new.revision_id;
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = new.attempt_id;
  select * into v_localization
  from public.test_revision_localizations localization
  where localization.revision_id = new.revision_id
    and localization.locale = new.locale;
  select * into v_identity
  from public.verified_identities identity
  where identity.user_id = new.user_id;

  v_expected_name := case
    when new.locale = 'zh' then
      concat_ws(' ', v_identity.surname, v_identity.name)
    else concat_ws(' ', v_identity.name, v_identity.surname)
  end;

  if v_attestation.id is null
    or v_revision.id is null
    or v_attempt.id is null
    or v_localization.revision_id is null
    or v_attestation.user_id <> new.user_id
    or v_attestation.revision_id <> new.revision_id
    or v_attestation.best_attempt_id <> new.attempt_id
    or v_attestation.best_score <> new.score
    or v_attestation.best_completed_at <> new.best_completed_at
    or v_attempt.locale <> new.locale
    or v_revision.question_count <> new.total
    or v_revision.pass_score <> new.pass_score
    or v_revision.slug <> new.test_slug
    or v_localization.title <> new.test_title
    or v_localization.title <> new.localized_test_title
    or new.score < new.pass_score
    or v_identity.status <> 'verified'
    or v_identity.version <> new.identity_version
    or v_expected_name <> new.full_name
    or v_identity.job <> new.job
    or v_identity.organization <> new.organization then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CERTIFICATE_SNAPSHOT_INVALID';
  end if;

  if new.issue_source = 'manual'
    and new.supersedes_certificate_id is not null then
    raise exception using errcode = 'check_violation',
      message = 'CERTIFICATE_LINEAGE_INVALID';
  end if;
  if new.issue_source <> 'manual' then
    if new.supersedes_certificate_id is null then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_PREDECESSOR_REQUIRED';
    end if;
    select * into v_predecessor
    from public.certificates certificate
    where certificate.id = new.supersedes_certificate_id;
    if v_predecessor.id is null
      or v_predecessor.user_id <> new.user_id
      or v_predecessor.revision_id <> new.revision_id
      or v_predecessor.revoked_at is null then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_LINEAGE_INVALID';
    end if;
    if new.issue_source = 'score_improvement'
      and new.score <= v_predecessor.score then
      raise exception using errcode = 'check_violation',
        message = 'CERTIFICATE_SCORE_IMPROVEMENT_REQUIRED';
    end if;
    if new.issue_source = 'identity_correction'
      and (
        new.attestation_id <> v_predecessor.attestation_id
        or new.score <> v_predecessor.score
        or new.identity_version <= v_predecessor.identity_version
      ) then
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

create or replace function private.issue_certificate_for_attestation(
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
  v_attempt public.test_attempts%rowtype;
  v_localization public.test_revision_localizations%rowtype;
  v_identity public.verified_identities%rowtype;
  v_certificate_id uuid;
  v_number text;
  v_user_id uuid;
  v_full_name text;
begin
  select attestation.user_id into v_user_id
  from public.attestations attestation
  join public.account_controls control
    on control.user_id = attestation.user_id
  where attestation.id = p_attestation_id
    and control.status = 'active'
    and not control.deletion_pending;
  if v_user_id is null then
    raise exception using errcode = 'no_data_found',
      message = 'ATTESTATION_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text, 0));
  select * into v_attestation
  from public.attestations attestation
  where attestation.id = p_attestation_id
  for update;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'ATTESTATION_NOT_FOUND';
  end if;
  select * into v_revision
  from public.test_revisions revision
  where revision.id = v_attestation.revision_id;
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = v_attestation.best_attempt_id;
  select * into v_localization
  from public.test_revision_localizations localization
  where localization.revision_id = v_attestation.revision_id
    and localization.locale = v_attempt.locale;
  if v_attestation.best_score < v_revision.pass_score then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTESTATION_NOT_ELIGIBLE';
  end if;
  if v_attempt.id is null or v_localization.revision_id is null then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'CERTIFICATE_LOCALIZATION_NOT_FOUND';
  end if;

  select * into v_identity
  from public.verified_identities identity
  where identity.user_id = v_attestation.user_id
  for update;
  if v_identity.user_id is null or v_identity.status <> 'verified' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'IDENTITY_NOT_VERIFIED';
  end if;
  if exists (
    select 1
    from public.certificates certificate
    where certificate.user_id = v_attestation.user_id
      and certificate.revision_id = v_attestation.revision_id
      and certificate.revoked_at is null
  ) then
    raise exception using errcode = 'unique_violation',
      message = 'ACTIVE_CERTIFICATE_EXISTS';
  end if;

  v_certificate_id := gen_random_uuid();
  v_number := 'SH-' || to_char(statement_timestamp(), 'YYYY') || '-'
    || upper(substr(replace(v_certificate_id::text, '-', ''), 1, 12));
  v_full_name := case
    when v_attempt.locale = 'zh' then
      concat_ws(' ', v_identity.surname, v_identity.name)
    else concat_ws(' ', v_identity.name, v_identity.surname)
  end;

  insert into public.certificates (
    id,
    certificate_number,
    user_id,
    revision_id,
    attestation_id,
    attempt_id,
    identity_version,
    full_name,
    job,
    organization,
    test_slug,
    test_title,
    localized_test_title,
    locale,
    score,
    total,
    pass_score,
    best_completed_at,
    issued_by,
    issue_source,
    supersedes_certificate_id
  ) values (
    v_certificate_id,
    v_number,
    v_attestation.user_id,
    v_revision.id,
    v_attestation.id,
    v_attestation.best_attempt_id,
    v_identity.version,
    v_full_name,
    v_identity.job,
    v_identity.organization,
    v_revision.slug,
    v_localization.title,
    v_localization.title,
    v_attempt.locale,
    v_attestation.best_score,
    v_revision.question_count,
    v_revision.pass_score,
    v_attestation.best_completed_at,
    p_actor_id,
    p_source,
    p_supersedes
  );

  insert into public.admin_audit_log (
    actor_user_id,
    target_user_id,
    action,
    target_type,
    target_id,
    after_data,
    batch_id
  ) values (
    p_actor_id,
    v_attestation.user_id,
    'certificate.issued',
    'certificate',
    v_certificate_id::text,
    jsonb_build_object(
      'certificateNumber', v_number,
      'source', p_source,
      'score', v_attestation.best_score,
      'revisionId', v_revision.id,
      'locale', v_attempt.locale
    ),
    p_batch_id
  );
  return v_certificate_id;
end;
$$;

create or replace function private.certificate_download_payload(
  p_certificate_id uuid
)
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
    'titleSnapshot', certificate.localized_test_title,
    'locale', certificate.locale,
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

create or replace function public.get_public_certificate(
  p_certificate_id uuid
)
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
    'titleSnapshot', certificate.localized_test_title,
    'locale', certificate.locale,
    'score', certificate.score,
    'total', certificate.total,
    'issuedAt', certificate.issued_at,
    'templateVersion', certificate.template_version,
    'revokedAt', certificate.revoked_at,
    'revokeReason', certificate.revoke_reason
  )
  from public.certificates certificate
  join public.account_controls control
    on control.user_id = certificate.user_id
  join auth.users auth_user
    on auth_user.id = certificate.user_id
  where certificate.id = p_certificate_id
    and auth_user.deleted_at is null
    and control.status = 'active'
    and not control.deletion_pending;
$$;

create or replace function private.resolve_certificate_export_unmetered(
  p_attestation_ids uuid[]
)
returns jsonb
language plpgsql
volatile
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
    raise exception using errcode = 'insufficient_privilege',
      message = 'CAPABILITY_REQUIRED';
  end if;
  v_requested := coalesce(cardinality(p_attestation_ids), 0);
  if v_requested > 500 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'EXPORT_SELECTION_TOO_LARGE';
  end if;

  with requested as (
    select distinct id
    from unnest(coalesce(p_attestation_ids, '{}'::uuid[])) id
  ), resolved as (
    select
      requested.id as requested_attestation_id,
      row.certificate_state,
      certificate.*
    from requested
    left join private.admin_attestation_rows row
      on row.attestation_id = requested.id
    left join public.certificates certificate
      on certificate.id = row.certificate_id
  )
  select
    count(*) filter (
      where resolved.certificate_state = 'issued'
        and resolved.id is not null
    ),
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
      'titleSnapshot', resolved.localized_test_title,
      'locale', resolved.locale,
      'score', resolved.score,
      'total', resolved.total,
      'passScore', resolved.pass_score,
      'bestCompletedAt', resolved.best_completed_at,
      'issuedAt', resolved.issued_at,
      'templateVersion', resolved.template_version,
      'revokedAt', resolved.revoked_at,
      'revokeReason', resolved.revoke_reason
    ) order by resolved.id) filter (
      where resolved.certificate_state = 'issued'
        and resolved.id is not null
    ), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'attestationId', resolved.requested_attestation_id,
      'reason', coalesce(resolved.certificate_state, 'not_found')
    ) order by resolved.requested_attestation_id) filter (
      where resolved.certificate_state is distinct from 'issued'
        or resolved.id is null
    ), '[]'::jsonb)
  into v_eligible, v_items, v_skipped
  from resolved;

  if v_eligible > 500 then
    raise exception using errcode = 'program_limit_exceeded',
      message = 'EXPORT_CERTIFICATE_LIMIT';
  end if;
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_actor_id,
    'certificate.exported',
    'certificate_export',
    v_batch_id::text,
    jsonb_build_object('requested', v_requested, 'eligible', v_eligible),
    v_batch_id
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

create or replace function public.resolve_certificate_export_job(
  p_job_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('results.export');
  v_job private.certificate_export_jobs%rowtype;
  v_items jsonb;
  v_skipped jsonb;
begin
  if not private.actor_has_capability(v_actor_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege',
      message = 'CAPABILITY_REQUIRED';
  end if;
  select * into v_job
  from private.certificate_export_jobs job
  where job.id = p_job_id
    and job.actor_user_id = v_actor_id
  for update;
  if not found
    or v_job.state <> 'ready'
    or v_job.expires_at <= statement_timestamp() then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'EXPORT_JOB_NOT_READY';
  end if;

  with requested as (
    select id from unnest(v_job.attestation_ids) id
  ), resolved as (
    select
      requested.id as requested_attestation_id,
      row.certificate_state,
      certificate.*
    from requested
    left join private.admin_attestation_rows row
      on row.attestation_id = requested.id
    left join public.certificates certificate
      on certificate.id = row.certificate_id
  )
  select
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
      'titleSnapshot', resolved.localized_test_title,
      'locale', resolved.locale,
      'score', resolved.score,
      'total', resolved.total,
      'passScore', resolved.pass_score,
      'bestCompletedAt', resolved.best_completed_at,
      'issuedAt', resolved.issued_at,
      'templateVersion', resolved.template_version,
      'revokedAt', resolved.revoked_at,
      'revokeReason', resolved.revoke_reason
    ) order by resolved.id) filter (
      where resolved.certificate_state = 'issued'
        and resolved.id is not null
    ), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'attestationId', resolved.requested_attestation_id,
      'reason', coalesce(resolved.certificate_state, 'not_found')
    ) order by resolved.requested_attestation_id) filter (
      where resolved.certificate_state is distinct from 'issued'
        or resolved.id is null
    ), '[]'::jsonb)
  into v_items, v_skipped
  from resolved;

  update private.certificate_export_jobs
  set downloaded_at = statement_timestamp()
  where id = v_job.id;

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data, batch_id
  ) values (
    v_actor_id,
    'certificate.export_job.downloaded',
    'certificate_export',
    v_job.id::text,
    jsonb_build_object(
      'requested', v_job.requested,
      'eligibleAtCreation', v_job.eligible,
      'exported', jsonb_array_length(v_items),
      'skipped', jsonb_array_length(v_skipped)
    ),
    v_job.id
  );

  return jsonb_build_object(
    'items', v_items,
    'skipped', v_skipped,
    'requested', v_job.requested,
    'total', v_job.requested,
    'eligible', jsonb_array_length(v_items)
  );
end;
$$;

revoke all on function private.set_attempt_locale_on_insert(),
  private.protect_attempt_locale(),
  private.attempt_payload(uuid,timestamptz),
  private.guard_certificate_snapshot(),
  private.issue_certificate_for_attestation(
    uuid,uuid,public.certificate_issue_source,uuid,uuid
  ), private.certificate_download_payload(uuid),
  private.resolve_certificate_export_unmetered(uuid[])
from public, anon, authenticated, service_role;

revoke all on function public.start_test_attempt_locale(
  text,public.app_locale
) from public, anon, authenticated, service_role;
grant execute on function public.start_test_attempt_locale(
  text,public.app_locale
) to authenticated;

-- Re-state the browser/service boundaries for replaced functions.
revoke execute on function public.start_test_attempt(text)
  from public, anon, service_role;
grant execute on function public.start_test_attempt(text) to authenticated;
revoke execute on function public.resolve_certificate_export_job(uuid)
  from public, anon, service_role;
grant execute on function public.resolve_certificate_export_job(uuid)
  to authenticated;
revoke execute on function public.get_public_certificate(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_public_certificate(uuid) to service_role;

comment on column public.test_attempts.locale is
  'Immutable locale snapshot selected when the attempt is created.';
comment on column public.certificates.locale is
  'Immutable locale snapshot inherited from the best passing attempt.';
comment on column public.certificates.localized_test_title is
  'Immutable localized course-title snapshot used by client-side certificate renderers.';
comment on function private.attempt_payload(uuid,timestamptz) is
  'Localized learner attempt payload without variant identity, answer keys, correctness, or explanations.';
