-- Three request paths spend real database and Storage work without any
-- anti-abuse budget, because `private.quota_policy` has no tariff for them and
-- `enforce_coarse_ip_quota` refuses an unknown action outright.
--
--   * `presentation.probe` — a HEAD request for a course PDF returns early,
--     before both download quotas, so the relay could be probed without limit
--     (B1-26).
--   * `admin.read.query` — the attestation selection resolver and the
--     organization merge preview each run an unbounded filter over the register
--     with no budget at all (B1-28).
--   * `certificate.export.download` — a ready export archive stays downloadable
--     for thirty minutes and could be replayed for the whole window (B1-27).
--
-- The whole catalog is restated because the function is replaced wholesale:
-- listing only the new actions would silently drop the existing tariffs.
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
      when 'certificate.export.download' then 30
      when 'presentation.download' then 12
      when 'presentation.probe' then 60
      when 'attempt.start' then 30
      when 'attempt.complete' then 30
      when 'auth.register' then 10
      when 'auth.otp.start' then 20
      when 'auth.otp.start.email' then 5
      when 'auth.otp.verify' then 30
      when 'auth.otp.verify.email' then 6
      when 'auth.zh.registration.options' then 10
      when 'auth.zh.registration.verify' then 15
      when 'auth.zh.authentication.options' then 60
      when 'auth.zh.authentication.verify' then 30
      when 'auth.zh.authentication.credential' then 10
      when 'auth.zh.recovery.options' then 10
      when 'auth.zh.recovery.verify' then 10
      when 'auth.zh.recovery.locator' then 5
      when 'avatar.upload' then 12
      when 'profile.update' then 30
      when 'legal.accept' then 10
      when 'content.article.mutate' then 20
      when 'admin.attestation.mutate' then 20
      when 'admin.identity.mutate' then 20
      when 'admin.certificate.revoke' then 20
      when 'admin.access.mutate' then 10
      when 'admin.test.mutate' then 20
      when 'admin.read.query' then 30
      when 'admin.zh_credential.reset' then 10
      when 'site.settings.update' then 10
      when 'admin.invite' then 10
      when 'admin.suspend' then 20
      when 'admin.delete' then 10
      when 'admin.purge' then 50
      when 'admin.reconcile' then 20
      else null
    end,
    case
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in ('auth.otp.start', 'auth.otp.start.email') then 900
      when p_action in ('auth.otp.verify', 'auth.otp.verify.email') then 900
      when p_action in (
        'auth.zh.registration.options', 'auth.zh.recovery.options',
        'auth.zh.recovery.verify', 'auth.zh.recovery.locator'
      ) then 3600
      when p_action in (
        'auth.zh.registration.verify', 'auth.zh.authentication.options',
        'auth.zh.authentication.verify', 'auth.zh.authentication.credential'
      ) then 900
      when p_action in (
        'presentation.download', 'presentation.probe', 'profile.update',
        'legal.accept', 'content.article.mutate', 'site.settings.update',
        'admin.access.mutate', 'admin.test.mutate', 'admin.zh_credential.reset',
        'admin.invite', 'admin.suspend', 'admin.delete', 'admin.purge',
        'admin.reconcile', 'certificate.export', 'certificate.export.download'
      ) then 300
      else 60
    end;
$$;

revoke all on function private.quota_policy(text)
  from public, anon, authenticated, service_role;
