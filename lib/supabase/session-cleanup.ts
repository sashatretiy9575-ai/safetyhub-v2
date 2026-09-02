import type { NextRequest, NextResponse as FrameworkNextResponse } from 'next/server';
import { isSupabaseAuthCookieName, supabaseAuthCookieOptions } from './auth-cookie-options';

/**
 * This hint is intentionally non-authoritative.  A small public-header client
 * island may use it to decide whether to render a convenience account action,
 * but no server authorization decision may ever read it.
 */
export const SAFETYHUB_SESSION_HINT_COOKIE = 'safetyhub-session-hint';

const LOCAL_AUTH_STATE_COOKIES = [
  // Kept for sessions created before the passwordless cutover.
  'safetyhub-password-context',
  // The current OTP challenge and its short-lived predecessor are local
  // browser state, not server identities.  Both must disappear on a
  // shared-device sign-out or auth-realm transition.
  'safetyhub-email-otp-challenge',
  'safetyhub-otp-challenge',
  SAFETYHUB_SESSION_HINT_COOKIE,
] as const;

type MutableResponse = FrameworkNextResponse;

function expireCookie(response: MutableResponse, name: string) {
  response.cookies.set(name, '', {
    ...supabaseAuthCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  });
}

/**
 * Clears only SafetyHub authentication and device-local state.  It never uses
 * `Clear-Site-Data: "cookies"`, which would also remove unrelated first-party
 * Cloudflare/Turnstile state.  The server account, history and certificates
 * are intentionally untouched.
 *
 * The response cookie list is inspected as well as the request list because
 * Supabase can refresh a chunked session while middleware is validating it.
 */
export function clearSafetyHubLocalSession(
  request: Pick<NextRequest, 'cookies'>,
  response: MutableResponse,
) {
  const authCookieNames = new Set<string>();
  for (const cookie of [...request.cookies.getAll(), ...response.cookies.getAll()]) {
    if (isSupabaseAuthCookieName(cookie.name)) authCookieNames.add(cookie.name);
  }

  for (const name of authCookieNames) expireCookie(response, name);
  for (const name of LOCAL_AUTH_STATE_COOKIES) expireCookie(response, name);

  // Quiz drafts and any SafetyHub Cache Storage entries are device-local.  A
  // client fallback clears known keys too, but this browser primitive covers
  // storage implementations the client cannot enumerate reliably.
  response.headers.set('Clear-Site-Data', '"cache", "storage"');
  return response;
}
