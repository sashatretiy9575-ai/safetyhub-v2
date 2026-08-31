-- The initial owner receives the admin role only after the normal email-OTP
-- journey has recorded every currently required legal acceptance.  Keep this
-- separate from the generic recovery helper: this is the only RPC used by the
-- one-time passwordless bootstrap command.
--
-- The table lock makes the legal-version check and role assignment a single
-- serialization point with a concurrent legal-document rotation.  Therefore
-- a newly current document cannot appear between the check and the grant.
create function public.bootstrap_email_otp_admin(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  lock table public.legal_document_versions in share mode;

  if not private.has_current_legal_acceptance(p_user_id) then
    raise exception using
      errcode = 'object_not_in_prerequisite_state',
      message = 'LEGAL_ACCEPTANCE_REQUIRED';
  end if;

  return public.restore_admin_access(p_user_id);
end;
$$;

revoke execute on function public.bootstrap_email_otp_admin(uuid)
  from public, anon, authenticated;
grant execute on function public.bootstrap_email_otp_admin(uuid) to service_role;

comment on function public.bootstrap_email_otp_admin(uuid) is
  'Deployment-only first-admin grant. Requires all current legal acceptances and is service-role-only.';
