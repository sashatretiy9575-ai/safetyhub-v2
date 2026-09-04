-- Tell an operator why a certificate cannot be issued.
--
-- `issue_certificate_for_attestation` answered ATTESTATION_NOT_FOUND for three
-- unrelated causes: a missing attestation, a suspended account, and an account
-- already marked for deletion. In production the third case was the common one
-- and the admin panel could only render it as "состояние изменилось".

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
  v_account_status public.account_status;
  v_account_deleting boolean;
begin
  -- Two very different situations used to share one code. An operator who had
  -- pressed "delete" on somebody, and whose deletion then never completed, saw
  -- every later action on that person fail as "the result no longer exists",
  -- which is both wrong and unactionable.
  select attestation.user_id, control.status, control.deletion_pending
  into v_user_id, v_account_status, v_account_deleting
  from public.attestations attestation
  join public.account_controls control
    on control.user_id = attestation.user_id
  where attestation.id = p_attestation_id;
  if v_user_id is null then
    raise exception using errcode = 'no_data_found',
      message = 'ATTESTATION_NOT_FOUND';
  end if;
  if v_account_deleting then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_DELETION_REQUESTED';
  end if;
  if v_account_status <> 'active' then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_SUSPENDED';
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
