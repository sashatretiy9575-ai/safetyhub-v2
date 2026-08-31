begin;

do $test$
declare
  v_missing_acceptance_user_id uuid := '5e190000-0000-4000-8000-000000000001';
  v_accepted_user_id uuid := '5e190000-0000-4000-8000-000000000002';
  v_blocked boolean := false;
  v_rotated_terms_version text := 'bootstrap-terms-9.9';
  v_bootstrapped_user_id uuid;
  v_definition text;
begin
  if to_regprocedure('public.bootstrap_email_otp_admin(uuid)') is null then
    raise exception 'passwordless first-admin bootstrap RPC is missing';
  end if;

  if has_function_privilege(
      'anon', 'public.bootstrap_email_otp_admin(uuid)', 'EXECUTE'
    )
    or has_function_privilege(
      'authenticated', 'public.bootstrap_email_otp_admin(uuid)', 'EXECUTE'
    )
    or not has_function_privilege(
      'service_role', 'public.bootstrap_email_otp_admin(uuid)', 'EXECUTE'
    ) then
    raise exception 'passwordless first-admin bootstrap grant boundary is invalid';
  end if;

  v_definition := lower(pg_get_functiondef('public.bootstrap_email_otp_admin(uuid)'::regprocedure));
  if position('lock table public.legal_document_versions in share mode' in v_definition) = 0
    or position('private.has_current_legal_acceptance(p_user_id)' in v_definition) = 0
    or position('legal_acceptance_required' in v_definition) = 0
    or position('public.restore_admin_access(p_user_id)' in v_definition) = 0 then
    raise exception 'passwordless first-admin bootstrap legal gate is incomplete';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_missing_acceptance_user_id,
      'authenticated', 'authenticated', 'bootstrap-missing@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_accepted_user_id,
      'authenticated', 'authenticated', 'bootstrap-accepted@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  begin
    perform public.bootstrap_email_otp_admin(v_missing_acceptance_user_id);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;

  if not v_blocked
    or exists (
      select 1
      from public.user_roles role
      where role.user_id = v_missing_acceptance_user_id and role.product_role = 'admin'
    ) then
    raise exception 'missing legal acceptance received first-admin access';
  end if;

  insert into public.legal_acceptances (user_id, document_type, version, source)
  select v_accepted_user_id, document.document_type, document.version, 'profile'
  from public.legal_document_versions document
  where document.is_current;

  perform public.publish_legal_document_version(
    'terms', v_rotated_terms_version, 'bootstrap-terms-9.9', statement_timestamp()
  );

  v_blocked := false;
  begin
    perform public.bootstrap_email_otp_admin(v_accepted_user_id);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LEGAL_ACCEPTANCE_REQUIRED' then
      v_blocked := true;
    else
      raise;
    end if;
  end;

  if not v_blocked
    or exists (
      select 1
      from public.user_roles role
      where role.user_id = v_accepted_user_id and role.product_role = 'admin'
    ) then
    raise exception 'stale legal acceptances received first-admin access';
  end if;

  insert into public.legal_acceptances (user_id, document_type, version, source)
  values (v_accepted_user_id, 'terms', v_rotated_terms_version, 'profile');

  -- Execute the mutating RPC before inspecting its effects. PostgreSQL may
  -- reorder boolean subexpressions, so combining the call with EXISTS would
  -- make this contract depend on an unspecified evaluation order.
  v_bootstrapped_user_id := public.bootstrap_email_otp_admin(v_accepted_user_id);

  if v_bootstrapped_user_id is distinct from v_accepted_user_id
    or not exists (
      select 1
      from public.user_roles role
      where role.user_id = v_accepted_user_id
        and role.role = 'admin'
        and role.product_role = 'admin'
    ) then
    raise exception 'all-current legal acceptances did not permit first-admin bootstrap';
  end if;
end;
$test$;

rollback;
