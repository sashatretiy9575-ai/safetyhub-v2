begin;

do $test$
declare
  v_admin_id uuid := '6e150000-0000-4000-8000-000000000001';
  v_ordinary_id uuid := '6e150000-0000-4000-8000-000000000002';
  v_incomplete_admin_id uuid := '6e150000-0000-4000-8000-000000000003';
  v_privacy_version text := 'bundle-privacy-9.9';
  v_terms_version text := 'bundle-terms-9.9';
  v_incomplete_privacy_version text := 'bundle-privacy-incomplete-9.9';
  v_incomplete_terms_version text := 'bundle-terms-incomplete-9.9';
  v_effective_at timestamptz := timestamptz '2030-01-15 00:00:00+00';
  v_locale public.app_locale;
  v_result jsonb;
  v_replayed jsonb;
  v_incomplete_blocked boolean := false;
  v_unauthorized_blocked boolean := false;
  v_legacy_authenticated_blocked boolean := false;
  v_legacy_service_blocked boolean := false;
begin
  if to_regprocedure('public.publish_legal_document_bundle(text,text)') is null then
    raise exception 'legal bundle publisher RPC is missing';
  end if;

  if has_function_privilege('anon', 'public.publish_legal_document_bundle(text,text)', 'execute')
    or not has_function_privilege('authenticated', 'public.publish_legal_document_bundle(text,text)', 'execute')
    or has_function_privilege('service_role', 'public.publish_legal_document_bundle(text,text)', 'execute') then
    raise exception 'legal bundle publisher execute boundary is invalid';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at
  ) values
    (
      '00000000-0000-0000-0000-000000000000', v_admin_id,
      'authenticated', 'authenticated', 'legal-bundle-admin@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_ordinary_id,
      'authenticated', 'authenticated', 'legal-bundle-ordinary@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_incomplete_admin_id,
      'authenticated', 'authenticated', 'legal-bundle-incomplete-admin@safetyhub.invalid', '',
      statement_timestamp(), '{}'::jsonb, '{}'::jsonb,
      statement_timestamp(), statement_timestamp()
    );

  update public.user_roles
  set role = 'admin'
  where user_id in (v_admin_id, v_incomplete_admin_id);

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin_id
  )::text, true);

  perform public.stage_legal_document_version(
    'privacy', v_privacy_version, 'legal-bundle-privacy-9.9', v_effective_at
  );
  perform public.stage_legal_document_version(
    'terms', v_terms_version, 'legal-bundle-terms-9.9', v_effective_at
  );

  foreach v_locale in array array['ru', 'kk', 'en', 'zh']::public.app_locale[] loop
    perform public.save_legal_document_localization(
      'privacy',
      v_privacy_version,
      v_locale,
      'Privacy ' || upper(v_locale::text),
      jsonb_build_object('document', 'privacy', 'locale', v_locale::text, 'release', '9.9'),
      null,
      true
    );
    perform public.save_legal_document_localization(
      'terms',
      v_terms_version,
      v_locale,
      'Terms ' || upper(v_locale::text),
      jsonb_build_object('document', 'terms', 'locale', v_locale::text, 'release', '9.9'),
      null,
      true
    );
  end loop;

  v_result := public.publish_legal_document_bundle(v_privacy_version, v_terms_version);
  if v_result -> 'privacy' ->> 'version' <> v_privacy_version
    or v_result -> 'terms' ->> 'version' <> v_terms_version
    or coalesce((v_result ->> 'replayed')::boolean, true) then
    raise exception 'legal bundle publisher returned an invalid receipt: %', v_result;
  end if;

  if (select count(*) from public.legal_document_versions legal
      where legal.is_current
        and (
          (legal.document_type = 'privacy' and legal.version = v_privacy_version)
          or (legal.document_type = 'terms' and legal.version = v_terms_version)
        )) <> 2
    or (select count(*) from public.legal_document_versions where is_current) <> 2
    or (select count(*) from public.legal_document_localizations localization
        where (localization.document_type = 'privacy' and localization.version = v_privacy_version)
           or (localization.document_type = 'terms' and localization.version = v_terms_version)) <> 8
    or exists (
      select 1
      from public.legal_document_localizations localization
      where ((localization.document_type = 'privacy' and localization.version = v_privacy_version)
          or (localization.document_type = 'terms' and localization.version = v_terms_version))
        and (
          localization.status <> 'published'
          or localization.published_by is distinct from v_admin_id
          or localization.published_at is null
        )
    ) then
    raise exception 'legal bundle publisher did not atomically activate all eight localizations';
  end if;

  -- legal.bundle_published is filtered out by the audit whitelist
  -- (20260905140000); idempotency is proven by the replay envelope alone.
  if (select count(*) from public.admin_audit_log audit
      where audit.action = 'legal.bundle_published'
        and audit.target_id = 'privacy:' || v_privacy_version || '|terms:' || v_terms_version) <> 0 then
    raise exception 'legal bundle publisher still writes to the action history';
  end if;

  v_replayed := public.publish_legal_document_bundle(v_privacy_version, v_terms_version);
  if coalesce((v_replayed ->> 'replayed')::boolean, false) is not true then
    raise exception 'legal bundle publisher replay was not idempotent';
  end if;

  -- Use a separate authorized actor for this negative fixture so the test
  -- exercises the bundle's completeness error instead of exhausting the
  -- real 20-mutation content quota with its setup writes.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_incomplete_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_incomplete_admin_id
  )::text, true);

  perform public.stage_legal_document_version(
    'privacy',
    v_incomplete_privacy_version,
    'legal-bundle-privacy-incomplete-9.9',
    v_effective_at + interval '1 day'
  );
  perform public.stage_legal_document_version(
    'terms',
    v_incomplete_terms_version,
    'legal-bundle-terms-incomplete-9.9',
    v_effective_at + interval '1 day'
  );
  foreach v_locale in array array['ru', 'kk', 'en', 'zh']::public.app_locale[] loop
    perform public.save_legal_document_localization(
      'privacy',
      v_incomplete_privacy_version,
      v_locale,
      'Incomplete privacy ' || upper(v_locale::text),
      jsonb_build_object('document', 'privacy', 'locale', v_locale::text, 'release', 'incomplete'),
      null,
      true
    );
    if v_locale <> 'zh'::public.app_locale then
      perform public.save_legal_document_localization(
        'terms',
        v_incomplete_terms_version,
        v_locale,
        'Incomplete terms ' || upper(v_locale::text),
        jsonb_build_object('document', 'terms', 'locale', v_locale::text, 'release', 'incomplete'),
        null,
        true
      );
    end if;
  end loop;

  begin
    perform public.publish_legal_document_bundle(
      v_incomplete_privacy_version, v_incomplete_terms_version
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LEGAL_BUNDLE_LOCALIZATIONS_INCOMPLETE' then
      v_incomplete_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_incomplete_blocked
    or exists (
      select 1 from public.legal_document_versions legal
      where legal.is_current
        and legal.version in (v_incomplete_privacy_version, v_incomplete_terms_version)
    )
    or exists (
      select 1 from public.legal_document_localizations localization
      where localization.version in (v_incomplete_privacy_version, v_incomplete_terms_version)
        and localization.status = 'published'
    ) then
    raise exception 'incomplete legal bundle was not rejected without mutation';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_ordinary_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_ordinary_id
  )::text, true);
  begin
    perform public.publish_legal_document_bundle(v_privacy_version, v_terms_version);
  exception when insufficient_privilege then
    if sqlerrm = 'CAPABILITY_REQUIRED' then
      v_unauthorized_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_unauthorized_blocked then
    raise exception 'ordinary authenticated user published a legal bundle';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_admin_id::text, true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'role', 'authenticated', 'sub', v_admin_id
  )::text, true);
  begin
    perform public.publish_legal_document_localizations('privacy', v_incomplete_privacy_version);
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LEGAL_BUNDLE_PUBLISH_REQUIRED' then
      v_legacy_authenticated_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legacy_authenticated_blocked then
    raise exception 'legacy authenticated legal publisher remained active';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  begin
    perform public.publish_legal_document_version(
      'privacy', 'legacy-service-should-not-stage', 'legacy-service-should-not-stage', v_effective_at
    );
  exception when object_not_in_prerequisite_state then
    if sqlerrm = 'LEGAL_BUNDLE_PUBLISH_REQUIRED' then
      v_legacy_service_blocked := true;
    else
      raise;
    end if;
  end;
  if not v_legacy_service_blocked
    or (select count(*) from public.legal_document_versions where is_current) <> 2
    or not exists (
      select 1 from public.legal_document_versions legal
      where legal.document_type = 'privacy' and legal.version = v_privacy_version and legal.is_current
    )
    or not exists (
      select 1 from public.legal_document_versions legal
      where legal.document_type = 'terms' and legal.version = v_terms_version and legal.is_current
    ) then
    raise exception 'legacy service legal publisher changed a current pointer';
  end if;
end;
$test$;

rollback;
