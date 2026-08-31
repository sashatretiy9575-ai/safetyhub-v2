-- The Supabase Auth Custom Access Token Hook runs as supabase_auth_admin.
-- Migration 20260831115000 grants that role EXECUTE on the hook, but function
-- resolution also requires USAGE on the containing public schema. Keep this
-- additive grant separate so already-applied provider-guard migrations remain
-- immutable.
grant usage on schema public to supabase_auth_admin;
