-- Defense-in-depth after the production baseline security review.
--
-- The public schema remains the PostgREST API surface, but sensitive draft
-- columns and every resource-changing RPC are now protected at the database
-- boundary as well as at the same-origin application boundary.

-- Published course rows previously exposed draft_content (including
-- correctOptionIndex) through a direct PostgREST SELECT. Keep public content
-- readable, but grant only the columns needed by the public read models.
revoke select on public.articles, public.tests, public.test_revisions,
  public.legal_document_versions from anon, authenticated;

grant select (
  id, slug, title, description, cover_image, blocks, status, is_published,
  published_at, jurisdiction, effective_date, reviewer, reviewed_at,
  next_review_at, sources, content_hash, reviewed_content_hash,
  created_at, updated_at
) on public.articles to anon, authenticated;

grant select (
  id, slug, title, description, current_revision_id, content_version,
  duration_minutes, pass_score, status, jurisdiction, effective_date,
  reviewer, reviewed_at, next_review_at, sources, content_hash,
  reviewed_content_hash, created_at, updated_at
) on public.tests to anon, authenticated;

grant select (
  id, test_id, version, slug, title, description, questions, question_count,
  duration_minutes, pass_score, published_at
) on public.test_revisions to anon, authenticated;

grant select (
  document_type, version, body_revision, effective_at, is_current, created_at
) on public.legal_document_versions to anon, authenticated;

-- Add explicit quotas for profile/storage work and content mutations. Unknown
-- action names remain deny-by-default.
create or replace function private.quota_policy(p_action text)
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
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
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
      when p_action = 'avatar.upload' then 3600
      when p_action in (
        'profile.update', 'legal.accept', 'content.article.mutate',
        'site.settings.update', 'admin.access.mutate', 'admin.test.mutate',
        'admin.invite', 'admin.suspend', 'admin.delete', 'admin.reconcile',
        'certificate.export'
      ) then 300
      else 60
    end;
$$;

create function private.enforce_actor_quota(p_action text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  v_result := public.consume_business_quota(p_action);
  if coalesce((v_result ->> 'allowed')::boolean, false) is not true then
    raise exception using
      errcode = 'program_limit_exceeded',
      message = 'RATE_LIMITED:' || greatest(1, coalesce((v_result ->> 'retryAfter')::integer, 1));
  end if;
end;
$$;

revoke all on function private.enforce_actor_quota(text)
  from public, anon, authenticated, service_role;

-- Move the reviewed mutation implementations behind metered wrappers. The
-- moved routines retain no browser grant; only their public wrappers are API.
alter function public.update_profile(text,text,text,text)
  rename to update_profile_unmetered;
alter function public.update_profile_unmetered(text,text,text,text)
  set schema private;
revoke all on function private.update_profile_unmetered(text,text,text,text)
  from public, anon, authenticated, service_role;

create function public.update_profile(
  p_name text, p_surname text, p_job text, p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('profile.update');
  return private.update_profile_unmetered(p_name, p_surname, p_job, p_organization);
end;
$$;

alter function public.accept_current_legal_documents(text,text,text,text)
  rename to accept_current_legal_documents_unmetered;
alter function public.accept_current_legal_documents_unmetered(text,text,text,text)
  set schema private;
revoke all on function private.accept_current_legal_documents_unmetered(text,text,text,text)
  from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('legal.accept');
  return private.accept_current_legal_documents_unmetered(
    p_privacy_version, p_privacy_body_revision,
    p_terms_version, p_terms_body_revision
  );
end;
$$;

alter function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  rename to save_article_draft_unmetered;
alter function public.save_article_draft_unmetered(uuid,text,text,text,text,text,jsonb,jsonb)
  set schema private;
revoke all on function private.save_article_draft_unmetered(uuid,text,text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('content.article.mutate');
  return private.save_article_draft_unmetered(
    p_article_id, p_original_slug, p_slug, p_title, p_description,
    p_cover_image, p_blocks, p_review_metadata
  );
end;
$$;

alter function public.set_article_status(uuid,public.article_status)
  rename to set_article_status_unmetered;
alter function public.set_article_status_unmetered(uuid,public.article_status)
  set schema private;
revoke all on function private.set_article_status_unmetered(uuid,public.article_status)
  from public, anon, authenticated, service_role;

create function public.set_article_status(
  p_article_id uuid, p_status public.article_status
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('content.article.mutate');
  return private.set_article_status_unmetered(p_article_id, p_status);
end;
$$;

alter function public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  rename to save_test_content_unmetered;
alter function public.save_test_content_unmetered(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  set schema private;
revoke all on function private.save_test_content_unmetered(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('admin.test.mutate');
  return private.save_test_content_unmetered(
    p_actor_id, p_test_id, p_slug, p_title, p_description,
    p_duration_minutes, p_questions, p_publish, p_review_metadata
  );
end;
$$;

alter function public.set_test_status(uuid,uuid,public.test_status)
  rename to set_test_status_unmetered;
alter function public.set_test_status_unmetered(uuid,uuid,public.test_status)
  set schema private;
revoke all on function private.set_test_status_unmetered(uuid,uuid,public.test_status)
  from public, anon, authenticated, service_role;

create function public.set_test_status(
  p_actor_id uuid, p_test_id uuid, p_status public.test_status
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
  v_result := private.set_test_status_unmetered(p_actor_id, p_test_id, p_status);
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    (select auth.uid()), 'test.status_changed', 'test', p_test_id::text,
    jsonb_build_object('status', p_status)
  );
  return v_result;
end;
$$;

alter function public.start_test_attempt(text)
  rename to start_test_attempt_unmetered;
alter function public.start_test_attempt_unmetered(text)
  set schema private;
revoke all on function private.start_test_attempt_unmetered(text)
  from public, anon, authenticated, service_role;

create function public.start_test_attempt(p_test_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('attempt.start');
  return private.start_test_attempt_unmetered(p_test_slug);
end;
$$;

-- Rebind the SQL alias to the metered public wrapper (the original dependency
-- followed the implementation object when it was moved to private).
create or replace function public.resume_test_attempt(p_test_slug text)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.start_test_attempt(p_test_slug);
$$;

alter function public.complete_test_attempt(uuid,jsonb)
  rename to complete_test_attempt_unmetered;
alter function public.complete_test_attempt_unmetered(uuid,jsonb)
  set schema private;
revoke all on function private.complete_test_attempt_unmetered(uuid,jsonb)
  from public, anon, authenticated, service_role;

create function public.complete_test_attempt(p_attempt_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('attempt.complete');
  return private.complete_test_attempt_unmetered(p_attempt_id, p_answers);
end;
$$;

-- Identity operations share the same per-user advisory lock used by result and
-- certificate work. Revoking identity also revokes every active certificate.
alter function public.verify_user_identity(uuid,text,text,text,text)
  rename to verify_user_identity_unmetered;
alter function public.verify_user_identity_unmetered(uuid,text,text,text,text)
  set schema private;
revoke all on function private.verify_user_identity_unmetered(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;

create function public.verify_user_identity(
  p_target_id uuid, p_name text, p_surname text, p_job text, p_organization text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('admin.identity.mutate');
  return private.verify_user_identity_unmetered(
    p_target_id, p_name, p_surname, p_job, p_organization
  );
end;
$$;

alter function public.revoke_user_identity(uuid,text)
  rename to revoke_user_identity_unmetered;
alter function public.revoke_user_identity_unmetered(uuid,text)
  set schema private;
revoke all on function private.revoke_user_identity_unmetered(uuid,text)
  from public, anon, authenticated, service_role;

create function public.revoke_user_identity(p_target_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('identity.manage');
  v_result jsonb;
  v_batch_id uuid := gen_random_uuid();
begin
  perform private.enforce_actor_quota('admin.identity.mutate');
  perform pg_advisory_xact_lock(hashtextextended(p_target_id::text, 0));
  v_result := private.revoke_user_identity_unmetered(p_target_id, p_reason);
  with revoked as (
    update public.certificates
    set revoked_at = statement_timestamp(),
        revoked_by = v_actor_id,
        revoke_reason = 'Данные пользователя отозваны'
    where user_id = p_target_id and revoked_at is null
    returning id, certificate_number
  )
  insert into public.admin_audit_log (
    actor_user_id, target_user_id, action, target_type, target_id,
    after_data, reason, batch_id
  )
  select
    v_actor_id, p_target_id, 'certificate.revoked', 'certificate',
    revoked.id::text,
    jsonb_build_object('certificateNumber', revoked.certificate_number),
    'Данные пользователя отозваны', v_batch_id
  from revoked;
  return v_result;
end;
$$;

alter function public.confirm_admin_identities(uuid[])
  rename to confirm_admin_identities_unmetered;
alter function public.confirm_admin_identities_unmetered(uuid[])
  set schema private;
revoke all on function private.confirm_admin_identities_unmetered(uuid[])
  from public, anon, authenticated, service_role;

create function public.confirm_admin_identities(p_user_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  return private.confirm_admin_identities_unmetered(p_user_ids);
end;
$$;

alter function public.bulk_update_participants(uuid[],text,text)
  rename to bulk_update_participants_unmetered;
alter function public.bulk_update_participants_unmetered(uuid[],text,text)
  set schema private;
revoke all on function private.bulk_update_participants_unmetered(uuid[],text,text)
  from public, anon, authenticated, service_role;

create function public.bulk_update_participants(
  p_user_ids uuid[], p_field text, p_value text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  return private.bulk_update_participants_unmetered(p_user_ids, p_field, p_value);
end;
$$;

alter function public.issue_certificates(uuid[])
  rename to issue_certificates_unmetered;
alter function public.issue_certificates_unmetered(uuid[])
  set schema private;
revoke all on function private.issue_certificates_unmetered(uuid[])
  from public, anon, authenticated, service_role;

create function public.issue_certificates(p_attestation_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('admin.attestation.mutate');
  return private.issue_certificates_unmetered(p_attestation_ids);
end;
$$;

alter function public.revoke_certificates(uuid[],text)
  rename to revoke_certificates_unmetered;
alter function public.revoke_certificates_unmetered(uuid[],text)
  set schema private;
revoke all on function private.revoke_certificates_unmetered(uuid[],text)
  from public, anon, authenticated, service_role;

create function public.revoke_certificates(p_certificate_ids uuid[], p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.enforce_actor_quota('admin.certificate.revoke');
  return private.revoke_certificates_unmetered(p_certificate_ids, p_reason);
end;
$$;

-- Rebind the single-document helper to the metered batch wrapper.
create or replace function public.revoke_certificate(
  p_certificate_id uuid, p_reason text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select public.revoke_certificates(array[p_certificate_id], p_reason) -> 0;
$$;

alter function public.update_site_settings(text,text,text,boolean,bigint)
  rename to update_site_settings_unmetered;
alter function public.update_site_settings_unmetered(text,text,text,boolean,bigint)
  set schema private;
revoke all on function private.update_site_settings_unmetered(text,text,text,boolean,bigint)
  from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('site.settings.update');
  return private.update_site_settings_unmetered(
    p_phone_e164, p_phone_display, p_whatsapp_e164,
    p_whatsapp_same_as_phone, p_expected_version
  );
end;
$$;

-- Administrative Auth operations remain a two-phase server workflow. Meter
-- preparation at the RPC boundary and retain request metadata in the private
-- outbox so the eventual domain commit can be audited accurately.
alter function public.prepare_user_invite(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) rename to prepare_user_invite_unmetered;
alter function public.prepare_user_invite_unmetered(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) set schema private;
revoke all on function private.prepare_user_invite_unmetered(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) from public, anon, authenticated, service_role;

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
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.invite');
  v_result := private.prepare_user_invite_unmetered(
    p_email, p_name, p_surname, p_job, p_requested_role, p_password_ticket,
    p_redirect_origin, p_correlation_id, p_request_id, p_ip_hash, p_user_agent
  );
  update private.auth_admin_outbox
  set payload = payload || jsonb_build_object('_audit', jsonb_strip_nulls(jsonb_build_object(
    'requestId', p_request_id,
    'ipHash', p_ip_hash,
    'userAgent', left(p_user_agent, 256)
  )))
  where id = (v_result ->> 'operationId')::uuid;
  return v_result;
end;
$$;

alter function public.request_account_suspension_confirmed(
  uuid,boolean,text,uuid,text,text,text
) rename to request_account_suspension_confirmed_unmetered;
alter function public.request_account_suspension_confirmed_unmetered(
  uuid,boolean,text,uuid,text,text,text
) set schema private;
revoke all on function private.request_account_suspension_confirmed_unmetered(
  uuid,boolean,text,uuid,text,text,text
) from public, anon, authenticated, service_role;

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
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.suspend');
  if exists (
    select 1
    from public.user_roles target_role
    where target_role.user_id = p_target_id
      and target_role.role in ('admin', 'superadmin')
  ) and not exists (
    select 1
    from public.user_roles actor_role
    where actor_role.user_id = v_actor_id and actor_role.role = 'superadmin'
  ) then
    raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
  end if;
  v_result := private.request_account_suspension_confirmed_unmetered(
    p_target_id, p_suspended, p_reason, p_correlation_id,
    p_request_id, p_ip_hash, p_user_agent
  );
  update private.auth_admin_outbox
  set payload = payload || jsonb_build_object('_audit', jsonb_strip_nulls(jsonb_build_object(
    'requestId', p_request_id,
    'ipHash', p_ip_hash,
    'userAgent', left(p_user_agent, 256)
  )))
  where id = (v_result ->> 'operationId')::uuid;
  return v_result;
end;
$$;

alter function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) rename to manage_user_role_confirmed_unmetered;
alter function public.manage_user_role_confirmed_unmetered(
  uuid,public.app_role,text,uuid,text,text,text
) set schema private;
revoke all on function private.manage_user_role_confirmed_unmetered(
  uuid,public.app_role,text,uuid,text,text,text
) from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('admin.access.mutate');
  -- Serializes the last-superadmin invariant across different target rows.
  perform pg_advisory_xact_lock(hashtextextended('safetyhub:superadmin-role', 0));
  return private.manage_user_role_confirmed_unmetered(
    p_target_id, p_role, p_reason, p_correlation_id,
    p_request_id, p_ip_hash, p_user_agent
  );
end;
$$;

alter function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) rename to set_user_capabilities_confirmed_unmetered;
alter function public.set_user_capabilities_confirmed_unmetered(
  uuid,text[],text,uuid,text,text,text
) set schema private;
revoke all on function private.set_user_capabilities_confirmed_unmetered(
  uuid,text[],text,uuid,text,text,text
) from public, anon, authenticated, service_role;

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
begin
  perform private.enforce_actor_quota('admin.access.mutate');
  return private.set_user_capabilities_confirmed_unmetered(
    p_target_id, p_capabilities, p_reason, p_correlation_id,
    p_request_id, p_ip_hash, p_user_agent
  );
end;
$$;

alter function public.claim_auth_admin_operation_confirmed(
  uuid,text,uuid,text,text,text
) rename to claim_auth_admin_operation_confirmed_unmetered;
alter function public.claim_auth_admin_operation_confirmed_unmetered(
  uuid,text,uuid,text,text,text
) set schema private;
revoke all on function private.claim_auth_admin_operation_confirmed_unmetered(
  uuid,text,uuid,text,text,text
) from public, anon, authenticated, service_role;

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
  v_result jsonb;
begin
  perform private.enforce_actor_quota('admin.reconcile');
  v_result := private.claim_auth_admin_operation_confirmed_unmetered(
    p_operation_id, p_reason, p_correlation_id,
    p_request_id, p_ip_hash, p_user_agent
  );
  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, reason,
    correlation_id, request_id, ip_hash, user_agent
  ) values (
    v_actor_id, 'auth_operation.claimed', 'auth_admin_operation', p_operation_id::text,
    private.normalize_profile_text(p_reason), coalesce(p_correlation_id, gen_random_uuid()),
    p_request_id, p_ip_hash, left(p_user_agent, 256)
  );
  return v_result;
end;
$$;

-- Only valid outbox state transitions may commit domain changes. Repeated
-- commit is idempotent, and the first commit creates an immutable audit event.
create or replace function public.advance_auth_admin_operation(
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
  v_target_id uuid;
  v_audit jsonb;
begin
  select * into v_operation
  from private.auth_admin_outbox where id = p_operation_id for update;
  if not found or v_operation.completion_token_hash <> v_expected then
    raise exception using errcode = 'insufficient_privilege', message = 'OUTBOX_TOKEN_INVALID';
  end if;
  if v_operation.state = 'committed' and p_state = 'committed' then
    return jsonb_build_object('operationId', p_operation_id, 'state', 'committed');
  end if;
  if v_operation.state in ('committed', 'rolled_back', 'failed')
    or p_state not in ('external_succeeded', 'committed', 'retryable', 'rolled_back', 'failed')
    or (p_state = 'external_succeeded'
      and v_operation.state not in ('prepared', 'retryable', 'external_succeeded'))
    or (p_state = 'committed' and v_operation.state <> 'external_succeeded') then
    raise exception using errcode = 'check_violation', message = 'OUTBOX_TRANSITION_INVALID';
  end if;
  v_target_id := coalesce(p_external_target_id, v_operation.target_id);
  if p_state in ('external_succeeded', 'committed') and v_target_id is null then
    raise exception using errcode = 'check_violation', message = 'OUTBOX_TARGET_REQUIRED';
  end if;
  if p_state = 'external_succeeded' then
    update private.auth_admin_outbox
    set state = p_state,
        target_id = v_target_id,
        attempts = attempts + 1,
        last_error = null
    where id = p_operation_id;
  elsif p_state = 'committed' then
    if v_operation.operation_type = 'invite' then
      if (v_operation.payload ->> 'requestedRole') = 'admin'
        and not exists (
          select 1 from public.user_roles actor_role
          where actor_role.user_id = v_operation.actor_user_id
            and actor_role.role = 'superadmin'
        ) then
        raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
      end if;
      update public.profiles
      set name = v_operation.payload ->> 'name',
          surname = v_operation.payload ->> 'surname',
          job = v_operation.payload ->> 'job'
      where id = v_target_id;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
      end if;
      update public.user_roles
      set role = (v_operation.payload ->> 'requestedRole')::public.app_role,
          created_by = v_operation.actor_user_id
      where user_id = v_target_id;
    elsif v_operation.operation_type in ('suspend', 'restore') then
      if exists (
        select 1 from public.user_roles target_role
        where target_role.user_id = v_target_id
          and target_role.role in ('admin', 'superadmin')
      ) and not exists (
        select 1 from public.user_roles actor_role
        where actor_role.user_id = v_operation.actor_user_id
          and actor_role.role = 'superadmin'
      ) then
        raise exception using errcode = 'insufficient_privilege', message = 'SUPERADMIN_REQUIRED';
      end if;
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
      where user_id = v_target_id;
      if not found then
        raise exception using errcode = 'no_data_found', message = 'USER_NOT_FOUND';
      end if;
    else
      raise exception using errcode = 'check_violation', message = 'OUTBOX_OPERATION_INVALID';
    end if;
    update private.auth_admin_outbox
    set state = 'committed', target_id = v_target_id, last_error = null
    where id = p_operation_id;
    v_audit := coalesce(v_operation.payload -> '_audit', '{}'::jsonb);
    insert into public.admin_audit_log (
      actor_user_id, target_user_id, action, target_type, target_id,
      after_data, reason, correlation_id, request_id, ip_hash, user_agent
    ) values (
      v_operation.actor_user_id,
      v_target_id,
      case v_operation.operation_type
        when 'invite' then 'user.invited'
        when 'suspend' then 'account.suspended'
        else 'account.restored'
      end,
      'user',
      v_target_id::text,
      jsonb_build_object('operationId', v_operation.id),
      v_operation.payload ->> 'reason',
      v_operation.correlation_id,
      v_audit ->> 'requestId',
      v_audit ->> 'ipHash',
      left(v_audit ->> 'userAgent', 256)
    );
  else
    update private.auth_admin_outbox
    set state = p_state, attempts = attempts + 1, last_error = left(p_error, 500)
    where id = p_operation_id;
  end if;
  return jsonb_build_object('operationId', p_operation_id, 'state', p_state);
end;
$$;

-- Attestation rows may only advance to a real completed attempt that belongs
-- to the same user/revision. This prevents a service-side programming error
-- from corrupting the certificate source of truth.
create function private.guard_attestation_best_attempt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt public.test_attempts%rowtype;
begin
  select * into v_attempt
  from public.test_attempts attempt
  where attempt.id = new.best_attempt_id;
  if v_attempt.id is null
    or v_attempt.user_id <> new.user_id
    or v_attempt.revision_id <> new.revision_id
    or v_attempt.status not in ('passed', 'failed')
    or v_attempt.score is distinct from new.best_score
    or v_attempt.completed_at is distinct from new.best_completed_at then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ATTESTATION_BEST_ATTEMPT_INVALID';
  end if;
  if TG_OP = 'UPDATE' then
    if (new.id, new.user_id, new.revision_id)
      is distinct from (old.id, old.user_id, old.revision_id)
      or new.best_score < old.best_score
      or (new.best_score = old.best_score
        and (new.best_completed_at, new.best_attempt_id)
          <= (old.best_completed_at, old.best_attempt_id)) then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'ATTESTATION_NOT_IMPROVED';
    end if;
  end if;
  return new;
end;
$$;

create trigger attestations_best_attempt_guard
before insert or update on public.attestations
for each row execute function private.guard_attestation_best_attempt();

-- Audit rows are append-only. Account purge is the sole delete path.
create function private.guard_admin_audit_log()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
begin
  if TG_OP = 'DELETE' and v_purge_actor <> ''
    and (old.actor_user_id::text = v_purge_actor
      or old.target_user_id::text = v_purge_actor) then
    return old;
  end if;
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'ADMIN_AUDIT_LOG_IMMUTABLE';
end;
$$;

create trigger admin_audit_log_immutable
before update or delete on public.admin_audit_log
for each row execute function private.guard_admin_audit_log();

-- Permit only privacy-preserving actor-reference anonymization during the
-- service-only account purge; all other revision/certificate fields stay
-- immutable.
create or replace function private.reject_immutable_row_change()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
begin
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

create or replace function private.guard_certificate_snapshot()
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
  v_purge_actor text := coalesce(current_setting('safetyhub.purge_actor_id', true), '');
begin
  if TG_OP = 'UPDATE' then
    if v_purge_actor <> ''
      and to_jsonb(new) - array['issued_by','revoked_by']
        = to_jsonb(old) - array['issued_by','revoked_by']
      and new.issued_by is not distinct from (
        case when old.issued_by::text = v_purge_actor then null else old.issued_by end
      )
      and new.revoked_by is not distinct from (
        case when old.revoked_by::text = v_purge_actor then null else old.revoked_by end
      ) then
      return new;
    end if;
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

-- Purge is idempotent for an already absent account, but a live account must
-- first be gated with begin_user_account_purge. Actor UUIDs in immutable
-- snapshots are anonymized before the Auth row and all owned data are removed.
create or replace function public.purge_user_account(p_target_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted boolean;
begin
  if p_target_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'USER_ID_REQUIRED';
  end if;
  if not exists (select 1 from auth.users where id = p_target_id) then
    return jsonb_build_object('deleted', false, 'userId', p_target_id);
  end if;
  if not exists (
    select 1 from public.account_controls
    where user_id = p_target_id and deletion_pending
  ) then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'ACCOUNT_PURGE_NOT_STARTED';
  end if;
  perform set_config('safetyhub.purge_actor_id', p_target_id::text, true);
  update public.test_revisions set published_by = null where published_by = p_target_id;
  update public.certificates set issued_by = null where issued_by = p_target_id;
  update public.certificates set revoked_by = null where revoked_by = p_target_id;
  delete from public.admin_audit_log
  where actor_user_id = p_target_id or target_user_id = p_target_id;
  delete from private.auth_admin_outbox
  where actor_user_id = p_target_id or target_id = p_target_id;
  delete from auth.users where id = p_target_id;
  v_deleted := found;
  return jsonb_build_object('deleted', v_deleted, 'userId', p_target_id);
end;
$$;

-- New wrappers get PostgreSQL's default EXECUTE privilege, so close the API
-- surface again before granting only the reviewed browser/service contracts.
revoke execute on function public.update_profile(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.accept_current_legal_documents(text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.set_article_status(uuid,public.article_status)
  from public, anon, authenticated, service_role;
revoke execute on function public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.set_test_status(uuid,uuid,public.test_status)
  from public, anon, authenticated, service_role;
revoke execute on function public.start_test_attempt(text)
  from public, anon, authenticated, service_role;
revoke execute on function public.complete_test_attempt(uuid,jsonb)
  from public, anon, authenticated, service_role;
revoke execute on function public.verify_user_identity(uuid,text,text,text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.revoke_user_identity(uuid,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.confirm_admin_identities(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.bulk_update_participants(uuid[],text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.issue_certificates(uuid[])
  from public, anon, authenticated, service_role;
revoke execute on function public.revoke_certificates(uuid[],text)
  from public, anon, authenticated, service_role;
revoke execute on function public.update_site_settings(text,text,text,boolean,bigint)
  from public, anon, authenticated, service_role;
revoke execute on function public.prepare_user_invite(
  text,text,text,text,public.app_role,text,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.request_account_suspension_confirmed(
  uuid,boolean,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.manage_user_role_confirmed(
  uuid,public.app_role,text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.set_user_capabilities_confirmed(
  uuid,text[],text,uuid,text,text,text
) from public, anon, authenticated, service_role;
revoke execute on function public.claim_auth_admin_operation_confirmed(
  uuid,text,uuid,text,text,text
) from public, anon, authenticated, service_role;

grant execute on function public.update_profile(text,text,text,text) to authenticated;
grant execute on function public.accept_current_legal_documents(text,text,text,text) to authenticated;
grant execute on function public.save_article_draft(uuid,text,text,text,text,text,jsonb,jsonb)
  to authenticated;
grant execute on function public.set_article_status(uuid,public.article_status) to authenticated;
grant execute on function public.save_test_content(uuid,uuid,text,text,text,integer,jsonb,boolean,jsonb)
  to authenticated;
grant execute on function public.set_test_status(uuid,uuid,public.test_status) to authenticated;
grant execute on function public.start_test_attempt(text) to authenticated;
grant execute on function public.complete_test_attempt(uuid,jsonb) to authenticated;
grant execute on function public.verify_user_identity(uuid,text,text,text,text) to authenticated;
grant execute on function public.revoke_user_identity(uuid,text) to authenticated;
grant execute on function public.confirm_admin_identities(uuid[]) to authenticated;
grant execute on function public.bulk_update_participants(uuid[],text,text) to authenticated;
grant execute on function public.issue_certificates(uuid[]) to authenticated;
grant execute on function public.revoke_certificates(uuid[],text) to authenticated;
grant execute on function public.update_site_settings(text,text,text,boolean,bigint) to authenticated;
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

-- Keep the service-only two-phase finalizer and account purge callable after
-- CREATE OR REPLACE; explicitly deny browser roles.
revoke execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  from public, anon, authenticated;
grant execute on function public.advance_auth_admin_operation(uuid,text,text,uuid,text)
  to service_role;
revoke execute on function public.purge_user_account(uuid)
  from public, anon, authenticated;
grant execute on function public.purge_user_account(uuid) to service_role;
