-- Retire revocation as a product concept.
--
-- `certificates.revoked_at` cannot be dropped: the partial unique index
-- `certificates_one_active_cycle_idx` is the only thing guaranteeing one live
-- certificate per (person, revision), and every reissue path — a better score,
-- a corrected name, an organization merge — requires its predecessor to carry
-- that timestamp. The column therefore stays, but it now means only
-- "superseded by a newer certificate", and nothing in the product calls it a
-- revocation any more.
--
-- Two consequences are handled here:
--   * a certificate number that was superseded resolves to the certificate that
--     replaced it, instead of rendering a red "revoked" verification page;
--   * certificates that were revoked by hand and never replaced are reissued
--     once, so the people holding them stop being stuck without a document.

create or replace function public.get_public_certificate(p_certificate_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with requested as (
    select * from public.certificates where id = p_certificate_id
  ), resolved as (
    select requested.* from requested where requested.revoked_at is null
    union all
    select successor.*
    from requested
    join lateral (
      select certificate.*
      from public.certificates certificate
      where certificate.user_id = requested.user_id
        and certificate.revision_id = requested.revision_id
        and certificate.revoked_at is null
      order by certificate.issued_at desc, certificate.id desc
      limit 1
    ) successor on true
    where requested.revoked_at is not null
  )
  select jsonb_build_object(
    'id', resolved.id,
    'certificateNumber', resolved.certificate_number,
    'fullName', resolved.full_name,
    'organization', resolved.organization,
    'testTitle', resolved.test_title,
    'score', resolved.score,
    'total', resolved.total,
    'issuedAt', resolved.issued_at
  )
  from resolved;
$$;

comment on function public.get_public_certificate(uuid) is
  'Public verification payload. A superseded certificate resolves to the one that replaced it; an unreplaced one verifies as not found.';

create or replace function public.get_certificate_download_payload(p_certificate_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := private.require_active_user();
  v_certificate public.certificates%rowtype;
  v_resolved_id uuid;
begin
  select * into v_certificate from public.certificates where id = p_certificate_id;
  if not found then return null; end if;
  if v_certificate.user_id is distinct from v_user_id
    and not private.actor_has_capability(v_user_id, 'certificate.read') then
    raise exception using errcode = 'insufficient_privilege', message = 'CERTIFICATE_READ_FORBIDDEN';
  end if;
  if v_certificate.revoked_at is not null then
    -- The holder asked for a document they legitimately own; hand them the
    -- current one rather than an error about an internal replacement.
    select certificate.id into v_resolved_id
    from public.certificates certificate
    where certificate.user_id = v_certificate.user_id
      and certificate.revision_id = v_certificate.revision_id
      and certificate.revoked_at is null
    order by certificate.issued_at desc, certificate.id desc
    limit 1;
    if v_resolved_id is null then return null; end if;
    return private.certificate_download_payload(v_resolved_id);
  end if;
  return private.certificate_download_payload(p_certificate_id);
end;
$$;

-- One-time repair: everyone whose only certificate for a course is a revoked
-- one gets a fresh document. `manual` is the only issue source allowed without
-- a predecessor link, and it is exactly what the operator "issue" button uses.
do $$
declare
  v_attestation_id uuid;
  v_batch_id uuid := gen_random_uuid();
begin
  for v_attestation_id in
    select distinct attestation.id
    from public.certificates certificate
    join public.attestations attestation
      on attestation.user_id = certificate.user_id
     and attestation.revision_id = certificate.revision_id
    where certificate.revoked_at is not null
      and certificate.course_deleted_at is null
      and not exists (
        select 1
        from public.certificates active
        where active.user_id = certificate.user_id
          and active.revision_id = certificate.revision_id
          and active.revoked_at is null
      )
    order by attestation.id
  loop
    begin
      perform private.issue_certificate_for_attestation(
        v_attestation_id, null, 'manual', null, v_batch_id
      );
    exception when others then
      -- Unverified identity, a failing score or a missing course localization:
      -- those rows stay for an operator to resolve from the employees screen.
      null;
    end;
  end loop;
end;
$$;
