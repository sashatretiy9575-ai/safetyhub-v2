begin;

do $test$
declare
  v_certificate public.certificates%rowtype;
  v_payload jsonb;
  v_owner uuid;
begin
  -- The public verification payload no longer carries a revocation at all.
  if position('revokedat' in lower(pg_get_functiondef(
      'public.get_public_certificate(uuid)'::regprocedure
    ))) > 0
    or position('revokereason' in lower(pg_get_functiondef(
      'public.get_public_certificate(uuid)'::regprocedure
    ))) > 0 then
    raise exception 'verification payload still exposes revocation';
  end if;

  select * into v_certificate
  from public.certificates
  where revoked_at is null and course_deleted_at is null
  order by id
  limit 1;
  if v_certificate.id is null then
    raise notice 'certificate behaviour skipped: no certificates seeded';
    return;
  end if;

  v_payload := public.get_public_certificate(v_certificate.id);
  if v_payload is null or v_payload ? 'revokedAt' or v_payload ? 'revokeReason' then
    raise exception 'active certificate payload is wrong: %', v_payload;
  end if;

  update public.certificates
  set revoked_at = statement_timestamp(), revoked_by = null, revoke_reason = 'замена документа'
  where id = v_certificate.id;

  -- With no replacement the old number simply stops resolving; it never renders
  -- as a revoked document.
  if public.get_public_certificate(v_certificate.id) is not null then
    raise exception 'a superseded certificate without a successor still verifies';
  end if;

  insert into public.certificates (
    certificate_number, user_id, revision_id, attestation_id, attempt_id, identity_version,
    full_name, job, organization, test_slug, test_title, localized_test_title, locale,
    score, total, pass_score, best_completed_at, issue_source, supersedes_certificate_id
  ) values (
    'SH-TEST-SUCCESSOR', v_certificate.user_id, v_certificate.revision_id,
    v_certificate.attestation_id, v_certificate.attempt_id, v_certificate.identity_version,
    v_certificate.full_name, v_certificate.job, v_certificate.organization,
    v_certificate.test_slug, v_certificate.test_title, v_certificate.localized_test_title,
    v_certificate.locale, v_certificate.score, v_certificate.total, v_certificate.pass_score,
    v_certificate.best_completed_at, 'manual', null
  );

  if (public.get_public_certificate(v_certificate.id) ->> 'certificateNumber')
    <> 'SH-TEST-SUCCESSOR' then
    raise exception 'a superseded number did not resolve to its replacement';
  end if;

  -- The owner downloading the old identifier receives the current document.
  v_owner := v_certificate.user_id;
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_payload := public.get_certificate_download_payload(v_certificate.id);
  if v_payload is null or v_payload ->> 'certificateNumber' <> 'SH-TEST-SUCCESSOR' then
    raise exception 'download payload did not follow the replacement: %', v_payload;
  end if;
end;
$test$;

rollback;
