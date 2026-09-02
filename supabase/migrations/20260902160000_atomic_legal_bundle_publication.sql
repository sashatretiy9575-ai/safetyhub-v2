-- A legal release is a consent pair.  Publishing Privacy and Terms through
-- separate RPC calls can otherwise leave a mixed-current interval in which a
-- learner accepts a pair that is immediately superseded by the second call.
-- Keep staging/editing independent, but make activation a single atomic
-- content.manage operation.

create function public.publish_legal_document_bundle(
  p_privacy_version text,
  p_terms_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := private.require_capability('content.manage');
  v_privacy_version text := btrim(coalesce(p_privacy_version, ''));
  v_terms_version text := btrim(coalesce(p_terms_version, ''));
  v_privacy public.legal_document_versions%rowtype;
  v_terms public.legal_document_versions%rowtype;
  v_current_privacy public.legal_document_versions%rowtype;
  v_current_terms public.legal_document_versions%rowtype;
  v_target_count integer := 0;
  v_target_complete_count integer := 0;
  v_target_published_count integer := 0;
  v_target_valid_hash_count integer := 0;
  v_current_count integer := 0;
  v_current_published_count integer := 0;
  v_current_valid_hash_count integer := 0;
  v_published_at timestamptz := statement_timestamp();
begin
  if char_length(v_privacy_version) not between 1 and 32
    or char_length(v_terms_version) not between 1 and 32 then
    raise exception using errcode = 'check_violation',
      message = 'LEGAL_BUNDLE_INVALID';
  end if;

  perform private.enforce_actor_quota('content.article.mutate');

  -- Serialize bundle activation with staging/current-pointer transitions.
  -- The following row lock still records the deterministic fine-grained
  -- order required by this contract: privacy before terms, then version.
  lock table public.legal_document_versions in share row exclusive mode;

  perform 1
  from public.legal_document_versions legal
  where (legal.document_type = 'privacy'::public.legal_document_type
      and (legal.is_current or legal.version = v_privacy_version))
     or (legal.document_type = 'terms'::public.legal_document_type
      and (legal.is_current or legal.version = v_terms_version))
  order by
    case legal.document_type
      when 'privacy'::public.legal_document_type then 1
      else 2
    end,
    legal.version
  for update;

  select legal.* into v_privacy
  from public.legal_document_versions legal
  where legal.document_type = 'privacy'::public.legal_document_type
    and legal.version = v_privacy_version;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'LEGAL_VERSION_NOT_FOUND';
  end if;

  select legal.* into v_terms
  from public.legal_document_versions legal
  where legal.document_type = 'terms'::public.legal_document_type
    and legal.version = v_terms_version;
  if not found then
    raise exception using errcode = 'no_data_found',
      message = 'LEGAL_VERSION_NOT_FOUND';
  end if;

  select legal.* into v_current_privacy
  from public.legal_document_versions legal
  where legal.document_type = 'privacy'::public.legal_document_type
    and legal.is_current;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_MIXED_STATE';
  end if;

  select legal.* into v_current_terms
  from public.legal_document_versions legal
  where legal.document_type = 'terms'::public.legal_document_type
    and legal.is_current;
  if not found then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_MIXED_STATE';
  end if;

  if v_privacy.effective_at is distinct from v_terms.effective_at then
    raise exception using errcode = 'check_violation',
      message = 'LEGAL_BUNDLE_EFFECTIVE_AT_MISMATCH';
  end if;

  -- Lock both prospective and existing-current localized copies in exactly
  -- the same order as version rows.  This prevents a draft-save from racing
  -- the completeness/hash validation below.
  perform 1
  from public.legal_document_localizations localization
  where (localization.document_type = 'privacy'::public.legal_document_type
      and localization.version in (v_privacy_version, v_current_privacy.version))
     or (localization.document_type = 'terms'::public.legal_document_type
      and localization.version in (v_terms_version, v_current_terms.version))
  order by
    case localization.document_type
      when 'privacy'::public.legal_document_type then 1
      else 2
    end,
    localization.version,
    localization.locale
  for update;

  select
    count(*),
    count(*) filter (where localization.status = 'complete'),
    count(*) filter (where localization.status = 'published'),
    count(*) filter (
      where localization.body_hash = encode(
        extensions.digest(convert_to(localization.body::text, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  into
    v_target_count,
    v_target_complete_count,
    v_target_published_count,
    v_target_valid_hash_count
  from public.legal_document_localizations localization
  where (localization.document_type = 'privacy'::public.legal_document_type
      and localization.version = v_privacy_version)
     or (localization.document_type = 'terms'::public.legal_document_type
      and localization.version = v_terms_version);

  if v_target_count <> 8
    or v_target_valid_hash_count <> 8
    or v_target_complete_count + v_target_published_count <> 8 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_LOCALIZATIONS_INCOMPLETE';
  end if;

  -- A completed historical pair must itself be a coherent published pair.
  -- This fails closed if an earlier one-document publisher left the database
  -- in a partially activated state.
  select
    count(*),
    count(*) filter (where localization.status = 'published'),
    count(*) filter (
      where localization.body_hash = encode(
        extensions.digest(convert_to(localization.body::text, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  into
    v_current_count,
    v_current_published_count,
    v_current_valid_hash_count
  from public.legal_document_localizations localization
  where (localization.document_type = 'privacy'::public.legal_document_type
      and localization.version = v_current_privacy.version)
     or (localization.document_type = 'terms'::public.legal_document_type
      and localization.version = v_current_terms.version);

  if v_current_count <> 8
    or v_current_published_count <> 8
    or v_current_valid_hash_count <> 8 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_MIXED_STATE';
  end if;

  if v_privacy.is_current <> v_terms.is_current then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_MIXED_STATE';
  end if;

  if v_privacy.is_current and v_terms.is_current then
    if v_target_published_count <> 8 then
      raise exception using errcode = 'object_not_in_prerequisite_state',
        message = 'LEGAL_BUNDLE_MIXED_STATE';
    end if;
    return private.ensure_rpc_payload(jsonb_build_object(
      'privacy', jsonb_build_object(
        'version', v_privacy.version,
        'bodyRevision', v_privacy.body_revision,
        'effectiveAt', v_privacy.effective_at
      ),
      'terms', jsonb_build_object(
        'version', v_terms.version,
        'bodyRevision', v_terms.body_revision,
        'effectiveAt', v_terms.effective_at
      ),
      'locales', jsonb_build_array('ru', 'kk', 'en', 'zh'),
      'replayed', true
    ));
  end if;

  if v_target_published_count <> 0 or v_target_complete_count <> 8 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_BUNDLE_MIXED_STATE';
  end if;

  perform set_config('safetyhub.legal_rotation', '1', true);
  update public.legal_document_versions
  set is_current = false
  where document_type in ('privacy'::public.legal_document_type, 'terms'::public.legal_document_type)
    and is_current;

  update public.legal_document_versions
  set is_current = true
  where (document_type = 'privacy'::public.legal_document_type
      and version = v_privacy_version)
     or (document_type = 'terms'::public.legal_document_type
      and version = v_terms_version);

  update public.legal_document_localizations
  set status = 'published',
      published_at = v_published_at,
      published_by = v_actor_id
  where (document_type = 'privacy'::public.legal_document_type
      and version = v_privacy_version)
     or (document_type = 'terms'::public.legal_document_type
      and version = v_terms_version);

  insert into public.admin_audit_log (
    actor_user_id, action, target_type, target_id, after_data
  ) values (
    v_actor_id,
    'legal.bundle_published',
    'legal_bundle',
    'privacy:' || v_privacy_version || '|terms:' || v_terms_version,
    jsonb_build_object(
      'privacy', jsonb_build_object(
        'version', v_privacy.version,
        'bodyRevision', v_privacy.body_revision,
        'effectiveAt', v_privacy.effective_at
      ),
      'terms', jsonb_build_object(
        'version', v_terms.version,
        'bodyRevision', v_terms.body_revision,
        'effectiveAt', v_terms.effective_at
      ),
      'locales', jsonb_build_array('ru', 'kk', 'en', 'zh'),
      'publishedAt', v_published_at
    )
  );

  return private.ensure_rpc_payload(jsonb_build_object(
    'privacy', jsonb_build_object(
      'version', v_privacy.version,
      'bodyRevision', v_privacy.body_revision,
      'effectiveAt', v_privacy.effective_at
    ),
    'terms', jsonb_build_object(
      'version', v_terms.version,
      'bodyRevision', v_terms.body_revision,
      'effectiveAt', v_terms.effective_at
    ),
    'locales', jsonb_build_array('ru', 'kk', 'en', 'zh'),
    'replayed', false
  ));
end;
$$;

-- Retain the legacy signatures so stale callers receive an actionable,
-- deterministic contract error instead of silently creating a mixed pair.
-- Staging and localization-save RPCs remain available.
create or replace function public.publish_legal_document_localizations(
  p_document_type public.legal_document_type,
  p_version text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.require_capability('content.manage');
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'LEGAL_BUNDLE_PUBLISH_REQUIRED';
end;
$$;

create or replace function public.publish_legal_document_version(
  p_document_type public.legal_document_type,
  p_version text,
  p_body_revision text,
  p_effective_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = 'object_not_in_prerequisite_state',
    message = 'LEGAL_BUNDLE_PUBLISH_REQUIRED';
end;
$$;

revoke all on function public.publish_legal_document_bundle(text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.publish_legal_document_bundle(text,text)
  to authenticated;

revoke all on function public.publish_legal_document_localizations(
  public.legal_document_type,text
) from public, anon, authenticated, service_role;
grant execute on function public.publish_legal_document_localizations(
  public.legal_document_type,text
) to authenticated;

revoke all on function public.publish_legal_document_version(
  public.legal_document_type,text,text,timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.publish_legal_document_version(
  public.legal_document_type,text,text,timestamptz
) to service_role;

comment on function public.publish_legal_document_bundle(text,text) is
  'Capability-gated atomic legal consent-bundle publisher. It locks, validates, and publishes all RU/KK/EN/ZH Privacy and Terms localizations together.';
comment on function public.publish_legal_document_localizations(
  public.legal_document_type,text
) is
  'Legacy activation signature disabled: use public.publish_legal_document_bundle(text,text).';
comment on function public.publish_legal_document_version(
  public.legal_document_type,text,text,timestamptz
) is
  'Legacy service activation signature disabled: use public.publish_legal_document_bundle(text,text).';
