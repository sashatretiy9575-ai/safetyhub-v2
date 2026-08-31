import type { CookieOptionsWithName } from '@supabase/ssr';

type AuthCookieEnvironment = Record<string, string | undefined>;

const SUPABASE_AUTH_COOKIE_PATTERN = /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/iu;

export function isSupabaseAuthCookieName(cookieName: string) {
  return SUPABASE_AUTH_COOKIE_PATTERN.test(cookieName);
}

/**
 * The application has no browser Supabase client, so session and PKCE state
 * never need to be script-readable. `lax` is required for the top-level GET
 * navigation from confirmation, invite, and recovery emails.
 *
 * No custom `name` is set: both clients therefore retain Supabase's canonical
 * project-scoped storage key and its built-in cookie chunking scheme.
 */
export function supabaseAuthCookieOptions(
  environment: AuthCookieEnvironment = process.env,
): CookieOptionsWithName {
  return {
    httpOnly: true,
    secure: environment.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
  };
}
