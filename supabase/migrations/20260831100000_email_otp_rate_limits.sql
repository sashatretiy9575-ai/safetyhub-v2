-- Passwordless email OTP has two independent coarse quotas: one selected from
-- request-network metadata and one from a server-only HMAC of the normalized
-- email. The browser cannot select these action names or submit raw IP/email
-- values to the quota RPC.

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
      when 'auth.register' then 10
      when 'auth.otp.start' then 20
      when 'auth.otp.start.email' then 5
      when 'auth.otp.verify' then 30
      when 'auth.otp.verify.email' then 6
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
      when p_action in ('auth.register', 'avatar.upload') then 3600
      when p_action in ('auth.otp.start', 'auth.otp.start.email') then 900
      when p_action in ('auth.otp.verify', 'auth.otp.verify.email') then 900
      when p_action in (
        'profile.update', 'legal.accept', 'content.article.mutate',
        'site.settings.update', 'admin.access.mutate', 'admin.test.mutate',
        'admin.invite', 'admin.suspend', 'admin.delete', 'admin.reconcile',
        'certificate.export'
      ) then 300
      else 60
    end;
$$;

comment on function private.quota_policy(text) is
  'Deny-by-default quota catalogue. Email OTP is limited separately by coarse network and server-HMAC email subjects.';
