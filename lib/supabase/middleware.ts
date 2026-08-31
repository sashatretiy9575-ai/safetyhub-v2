import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import type { Database } from './types';
import { supabaseAuthCookieOptions } from './auth-cookie-options';

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
