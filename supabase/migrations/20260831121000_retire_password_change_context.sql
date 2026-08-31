-- Password authentication was retired in favour of email OTP.  This is
-- deliberately forward-only: applied migrations remain an auditable record.
drop function if exists public.create_password_change_context(text, uuid, text, uuid, timestamptz);
drop function if exists public.claim_password_change_context(text, text, uuid, uuid);
drop function if exists public.inspect_password_change_context(text, uuid, uuid);
drop function if exists public.consume_password_change_context(text, text, uuid, uuid);
drop function if exists public.delete_password_change_context(text);
drop table if exists private.password_change_contexts;
