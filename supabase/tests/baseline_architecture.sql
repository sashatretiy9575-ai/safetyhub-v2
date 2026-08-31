begin;

do $test$
declare
  v_missing text[];
begin
  select array_agg(required.name order by required.name)
  into v_missing
  from (values
    ('profiles'), ('user_roles'), ('account_controls'),
    ('admin_capability_catalog'), ('user_capabilities'), ('verified_identities'),
    ('articles'), ('article_slug_redirects'), ('tests'), ('test_revisions'),
    ('test_attempts'), ('attestations'), ('certificates'),
    ('legal_document_versions'), ('legal_acceptances'), ('site_settings'),
    ('admin_audit_log')
  ) required(name)
  where to_regclass('public.' || required.name) is null;
  if v_missing is not null then
    raise exception 'missing public tables: %', v_missing;
  end if;

  if to_regclass('private.test_revision_answer_keys') is null
    or to_regclass('private.business_rate_limits') is null
    or to_regclass('private.coarse_ip_rate_limits') is null
    or to_regclass('private.auth_admin_outbox') is null then
    raise exception 'required private table missing';
  end if;

  if to_regclass('private.password_change_contexts') is not null
    or to_regprocedure('public.create_password_change_context(text,uuid,text,uuid,timestamptz)') is not null
    or to_regprocedure('public.claim_password_change_context(text,text,uuid,uuid)') is not null
    or to_regprocedure('public.inspect_password_change_context(text,uuid,uuid)') is not null
    or to_regprocedure('public.consume_password_change_context(text,text,uuid,uuid)') is not null
    or to_regprocedure('public.delete_password_change_context(text)') is not null then
    raise exception 'retired password context survived';
  end if;

  if to_regclass('public.attempt_items') is not null
    or to_regclass('private.attempt_answer_keys') is not null
    or to_regclass('private.attempt_rate_limits') is not null
    or to_regclass('public.pending_certificate_issuances') is not null
    or to_regclass('private.certificate_pdf_projections') is not null
    or to_regclass('private.certificate_verification_tokens') is not null
    or to_regclass('private.mfa_recovery_codes') is not null then
    raise exception 'legacy storage survived clean baseline';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'certificates'
      and column_name in ('pdf_data', 'pdf_base64', 'verification_token')
  ) then
    raise exception 'certificate persistence/token column survived';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'test_attempts'
      and column_name = 'answers' and udt_name = '_int2'
  ) then
    raise exception 'test_attempts.answers is not smallint[]';
  end if;

  if to_regprocedure('public.save_attempt_answer(uuid,uuid,uuid)') is not null then
    raise exception 'per-click answer RPC survived';
  end if;

  if not exists (select 1 from pg_trigger
      where tgname = 'test_revisions_immutable' and not tgisinternal)
    or not exists (select 1 from pg_trigger
      where tgname = 'test_revision_answer_keys_immutable' and not tgisinternal)
    or not exists (select 1 from pg_trigger
      where tgname = 'certificates_snapshot_guard' and not tgisinternal)
    or not exists (select 1 from pg_trigger
      where tgname = 'user_roles_audit_direct_change' and not tgisinternal) then
    raise exception 'immutability or direct-role audit guard missing';
  end if;
end;
$test$;

rollback;
