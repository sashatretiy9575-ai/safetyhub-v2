import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { AuthRealm } from '@/i18n/config';
import type { Database } from './types';
import { supabaseAuthCookieOptions } from './auth-cookie-options';

type AuthenticatedUserMetadata = Readonly<{
  app_metadata?: unknown;
}>;

/**
 * This is an inexpensive middleware hint, not the database authority for a
 * realm.  `auth.getUser()` verifies the Supabase user before it reaches here;
 * private.assert_locale_matches_auth_realm remains the authoritative guard on
 * every locale-aware database boundary. Ordinary accounts have no
 * `safetyhub_auth_kind`; a retired or malformed nonempty marker has no
 * browser realm and is failed closed on protected/auth-entry routes.
 */
export function authRealmForSessionUser(
  user: AuthenticatedUserMetadata | null | undefined,
): AuthRealm | null {
  const metadata = user?.app_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return 'email_otp';
  }

  const authKind = (metadata as Record<string, unknown>).safetyhub_auth_kind;
  if (authKind === undefined) return 'email_otp';
  if (authKind === 'zh_username_password') {
    return 'zh_username_password';
  }

  // A retired ZH passkey (or any unexpected credential marker) must not be
  // treated as a normal email session. Returning no realm makes the proxy
  // clear it on a private/auth-entry route; the SQL assertion independently
  // denies it at every locale-aware data boundary.
  return null;
}

export async function updateSession(request: NextRequest, forwardedHeaders?: Headers) {
  const nextResponse = () => {
    const headers = new Headers(forwardedHeaders ?? request.headers);
    const cookie = request.cookies.toString();
    if (cookie) headers.set('cookie', cookie);
    return NextResponse.next({ request: { headers } });
  };
  let response = nextResponse();

  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !publishableKey) {
    return { response, user: null, supabase: null as never };
  }

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    publishableKey,
    {
      cookieOptions: supabaseAuthCookieOptions(),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, responseHeaders) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = nextResponse();
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
          for (const [name, value] of Object.entries(responseHeaders)) {
            response.headers.set(name, value);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  return { response, user, supabase };
}
