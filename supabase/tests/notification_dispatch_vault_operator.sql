begin;

do $test$
declare
  v_url text := 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co/functions/v1/telegram-dispatcher';
  v_secret text := 'vault-operator-test-secret-000000000000000000000001';
  v_reason text := 'Configure dispatcher Vault values for SQL contract test';
  v_key uuid := '7d000000-0000-4000-8000-000000000001';
  v_result jsonb;
  v_replay jsonb;
  v_failed boolean;
  v_stored_url text;
  v_stored_secret text;
begin
  if to_regclass('private.notification_dispatch_vault_receipts') is null
    or to_regprocedure(
      'public.configure_notification_dispatch_vault(text,text,text,uuid)'
    ) is null then
    raise exception 'notification dispatch Vault operator contract is incomplete';
  end if;

  if has_table_privilege(
      'anon', 'private.notification_dispatch_vault_receipts', 'select'
    )
    or has_table_privilege(
      'authenticated', 'private.notification_dispatch_vault_receipts', 'select'
    )
    or has_table_privilege(
      'service_role', 'private.notification_dispatch_vault_receipts', 'select'
    )
    or has_function_privilege(
      'authenticated',
      'public.configure_notification_dispatch_vault(text,text,text,uuid)',
      'execute'
    )
    or not has_function_privilege(
      'service_role',
      'public.configure_notification_dispatch_vault(text,text,text,uuid)',
      'execute'
    ) then
    raise exception 'notification dispatch Vault operator grants are unsafe';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  v_failed := false;
  begin
    perform public.configure_notification_dispatch_vault(
      v_url, v_secret, v_reason, v_key
    );
  exception when insufficient_privilege then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'authenticated role configured Vault';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_result := public.configure_notification_dispatch_vault(
    v_url, v_secret, v_reason, v_key
  );
  if v_result is distinct from jsonb_build_object(
    'configured', true,
    'vaultNames', jsonb_build_array(
      'notification_dispatch_url',
      'notification_dispatch_secret'
    )
  ) then
    raise exception 'Vault operator result is invalid: %', v_result;
  end if;
  if v_result::text like '%' || v_secret || '%'
    or v_result::text like '%' || v_url || '%' then
    raise exception 'Vault operator result leaked configuration bytes';
  end if;

  v_replay := public.configure_notification_dispatch_vault(
    v_url, v_secret, v_reason, v_key
  );
  if v_replay is distinct from v_result then
    raise exception 'Vault operator replay is not idempotent';
  end if;

  execute $query$
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'notification_dispatch_url'
  $query$ into strict v_stored_url;
  execute $query$
    select decrypted_secret
    from vault.decrypted_secrets
    where name = 'notification_dispatch_secret'
  $query$ into strict v_stored_secret;
  if v_stored_url is distinct from v_url or v_stored_secret is distinct from v_secret then
    raise exception 'Vault operator did not persist the exact values';
  end if;

  if (select count(*) from private.notification_dispatch_vault_receipts) <> 1
    or exists (
      select 1
      from private.notification_dispatch_vault_receipts receipt
      where receipt.request_hash !~ '^[0-9a-f]{64}$'
        or receipt.result::text like '%' || v_secret || '%'
        or receipt.result::text like '%' || v_url || '%'
    ) then
    raise exception 'Vault operator receipt is invalid or leaked configuration bytes';
  end if;
  -- notification_dispatch.vault_configured is filtered out by the audit
  -- whitelist (20260905140000); the vault receipt above stays the record.
  if exists (
    select 1
    from public.admin_audit_log audit
    where audit.action = 'notification_dispatch.vault_configured'
  ) then
    raise exception 'Vault operator still writes to the action history';
  end if;

  v_failed := false;
  begin
    perform public.configure_notification_dispatch_vault(
      v_url,
      v_secret || '-different',
      v_reason,
      v_key
    );
  exception when unique_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Vault operator accepted an idempotency conflict';
  end if;

  v_failed := false;
  begin
    perform public.configure_notification_dispatch_vault(
      'https://attacker.example/telegram-dispatcher',
      v_secret,
      v_reason,
      '7d000000-0000-4000-8000-000000000002'
    );
  exception when check_violation then
    v_failed := true;
  end;
  if not v_failed then
    raise exception 'Vault operator accepted an untrusted dispatcher URL';
  end if;
end;
$test$;

rollback;
