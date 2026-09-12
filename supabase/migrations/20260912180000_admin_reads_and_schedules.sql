-- Admin reads that used to scan or fetch whole tables, and background jobs
-- that ran far more often than their work required.
--
-- 1. Indexes for the admin lists and the work-queue counters.
-- 2. One RPC for the article draft list (was two PostgREST reads of every
--    column, including the block JSON) with a normalized, trigram-backed search.
-- 3. A batch avatar manifest read, so the approval queue and the employee
--    list resolve avatars in one round-trip instead of three per row.
-- 4. Service-role access to the work-queue counters, which the application now
--    caches for thirty seconds instead of recounting on every admin page.
-- 5. The notification sweep runs every five minutes and only when a delivery
--    is actually due; the after-insert trigger still dispatches new events at
--    once. The idle tick used to decrypt two Vault secrets and enqueue an HTTP
--    request every minute for an empty queue.
-- 6. The storage reconciler gets a daily schedule through Vault, mirroring the
--    notification dispatcher. Until the Vault pair is configured the job is a
--    no-op.

-- 1. Indexes -----------------------------------------------------------------

create index if not exists article_drafts_updated_idx
  on public.article_drafts (updated_at desc, article_id);

create index if not exists article_drafts_title_trgm_idx
  on public.article_drafts
  using gin (private.normalized_lookup_key(title) extensions.gin_trgm_ops);

create index if not exists tests_status_updated_idx
  on public.tests (status, updated_at desc, id);

create index if not exists content_assets_active_created_idx
  on public.content_assets (created_at desc, id)
  where status = 'active';

create index if not exists certificates_active_idx
  on public.certificates (id)
  where revoked_at is null;

create index if not exists profiles_unlinked_organization_idx
  on public.profiles (id)
  where organization <> '' and organization_id is null;

-- 2. Article draft list ------------------------------------------------------

create or replace function public.list_admin_article_drafts(
  p_query text default null,
  p_limit integer default 200
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', row.article_id,
        'slug', row.slug,
        'title', row.title,
        'status', row.status,
        'isPublished', row.is_published,
        'updatedAt', row.updated_at,
        'hasDraftChanges', row.status = 'published'
          and row.live_content_hash is distinct from row.content_hash
      )
      order by row.updated_at desc, row.article_id desc
    ),
    '[]'::jsonb
  )
  from (
    select
      draft.article_id,
      draft.slug,
      draft.title,
      draft.updated_at,
      draft.content_hash,
      article.status,
      article.is_published,
      article.content_hash as live_content_hash
    from public.article_drafts draft
    join public.articles article on article.id = draft.article_id
    where coalesce((select auth.role()), '') = 'service_role'
      and article.status in ('draft', 'published')
      and (
        nullif(btrim(coalesce(p_query, '')), '') is null
        or private.normalized_lookup_key(draft.title) like
          '%' || replace(replace(replace(
            private.normalized_lookup_key(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
    order by draft.updated_at desc, draft.article_id desc
    limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) row;
$$;

revoke execute on function public.list_admin_article_drafts(text, integer)
  from public, anon, authenticated;
grant execute on function public.list_admin_article_drafts(text, integer)
  to service_role;

-- 3. Batch avatar manifests ---------------------------------------------------

create or replace function public.get_profile_avatar_manifests(p_user_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'userId', manifest.user_id,
        'objectKey', manifest.object_key,
        'sha256', manifest.sha256,
        'bytes', manifest.byte_length,
        'legacyImported', manifest.legacy_imported,
        'updatedAt', manifest.updated_at
      )
    ),
    '[]'::jsonb
  )
  from private.profile_avatar_manifests manifest
  join public.account_controls control on control.user_id = manifest.user_id
  join auth.users auth_user on auth_user.id = manifest.user_id
  where coalesce((select auth.role()), '') = 'service_role'
    and manifest.user_id = any (p_user_ids[1:100])
    and auth_user.deleted_at is null
    and control.status = 'active'
    and not control.deletion_pending;
$$;

revoke execute on function public.get_profile_avatar_manifests(uuid[])
  from public, anon, authenticated;
grant execute on function public.get_profile_avatar_manifests(uuid[])
  to service_role;

-- 4. Work queue counters for the service role ---------------------------------

create or replace function public.get_admin_work_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- The application reads the counters through the service role from a short
  -- server cache and checks the capability itself; a signed-in operator can
  -- still call the function directly under the same capability as before.
  if coalesce((select auth.role()), '') <> 'service_role' then
    perform private.require_capability('results.read');
  end if;
  return jsonb_build_object(
    'pendingIdentity', (
      select count(distinct row.user_id)
      from private.admin_attestation_rows row
      where row.test_id is not null and row.identity_state <> 'verified'
    ),
    'readyToIssue', (
      select count(*)
      from private.admin_attestation_rows row
      where row.test_id is not null and row.certificate_state in ('ready', 'revoked')
    ),
    'companyIssues', (
      select count(*)
      from public.profiles profile
      where profile.organization <> '' and profile.organization_id is null
    ),
    'activeCertificates', (
      select count(*) from public.certificates certificate where certificate.revoked_at is null
    ),
    'generatedAt', statement_timestamp()
  );
end;
$$;

revoke execute on function public.get_admin_work_queue() from public, anon;
grant execute on function public.get_admin_work_queue() to authenticated, service_role;

-- 5. Notification sweep: five minutes, and only when something is due ---------

select cron.schedule(
  'safetyhub-notification-dispatch',
  '*/5 * * * *',
  $job$
    select private.request_notification_dispatch('scheduled', null)
    where private.runtime_feature_enabled('telegram_delivery')
      and exists (
        select 1
        from private.notification_deliveries delivery
        where (
            delivery.status in ('pending', 'retry')
            and delivery.next_attempt_at <= statement_timestamp()
          )
          or (
            delivery.status = 'leased'
            and delivery.lease_expires_at <= statement_timestamp()
          )
      )
  $job$
);

-- 6. Daily storage reconcile through Vault ------------------------------------

create or replace function private.request_storage_reconcile()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
  v_request_id bigint;
begin
  begin
    execute $query$
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'storage_reconciler_url'
      limit 1
    $query$ into v_url;
    execute $query$
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'storage_reconciler_secret'
      limit 1
    $query$ into v_secret;
  exception when others then
    return null;
  end;
  if nullif(btrim(v_url), '') is null
    or v_url !~ '^https://[^[:space:]]+$'
    or nullif(v_secret, '') is null
    or char_length(v_secret) < 32 then
    return null;
  end if;
  begin
    select net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || v_secret
      ),
      body := jsonb_build_object('reason', 'scheduled', 'requestedAt', statement_timestamp()),
      timeout_milliseconds := 5000
    ) into v_request_id;
  exception when others then
    return null;
  end;
  return v_request_id;
end;
$$;

revoke all on function private.request_storage_reconcile() from public;

create or replace function public.configure_storage_reconciler_vault(
  p_reconciler_url text,
  p_reconciler_secret text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_url_ids uuid[];
  v_secret_ids uuid[];
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'SERVICE_ROLE_REQUIRED';
  end if;
  if p_reconciler_url is null
    or char_length(p_reconciler_url) > 512
    or p_reconciler_url !~ '^https://[a-z0-9]{20}[.]supabase[.]co/functions/v1/storage-reconciler$'
    or p_reconciler_secret is null
    or char_length(p_reconciler_secret) not between 32 and 512
    or p_reconciler_secret ~ '[[:cntrl:]]' then
    raise exception using errcode = 'check_violation',
      message = 'STORAGE_RECONCILER_VAULT_REQUEST_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('storage-reconciler-vault-config', 0));
  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret
    where secret.name = 'storage_reconciler_url'
  $query$ into v_url_ids;
  execute $query$
    select coalesce(array_agg(secret.id order by secret.id), '{}'::uuid[])
    from vault.secrets secret
    where secret.name = 'storage_reconciler_secret'
  $query$ into v_secret_ids;
  if cardinality(v_url_ids) > 1 or cardinality(v_secret_ids) > 1 then
    raise exception using errcode = 'object_not_in_prerequisite_state',
      message = 'STORAGE_RECONCILER_VAULT_AMBIGUOUS';
  end if;

  if cardinality(v_url_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_reconciler_url, 'storage_reconciler_url',
        'Storage reconciler function URL called by pg_cron';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_url_ids[1], p_reconciler_url, 'storage_reconciler_url',
        'Storage reconciler function URL called by pg_cron';
  end if;
  if cardinality(v_secret_ids) = 0 then
    execute 'select vault.create_secret($1, $2, $3)'
      using p_reconciler_secret, 'storage_reconciler_secret',
        'Bearer secret for the storage reconciler function';
  else
    execute 'select vault.update_secret($1, $2, $3, $4)'
      using v_secret_ids[1], p_reconciler_secret, 'storage_reconciler_secret',
        'Bearer secret for the storage reconciler function';
  end if;

  return jsonb_build_object('configured', true, 'configuredAt', statement_timestamp());
end;
$$;

revoke execute on function public.configure_storage_reconciler_vault(text, text)
  from public, anon, authenticated;
grant execute on function public.configure_storage_reconciler_vault(text, text)
  to service_role;

select cron.schedule(
  'safetyhub-storage-reconcile',
  '25 3 * * *',
  $job$select private.request_storage_reconcile();$job$
);
