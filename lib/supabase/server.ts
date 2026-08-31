import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { cache } from 'react';
import type { Database } from './types';
import { supabaseAuthCookieOptions } from './auth-cookie-options';

function createFallbackClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
    }),
    rpc: async () => ({ data: null, error: null }),
  } as unknown as ReturnType<typeof createServerClient<Database>>;
}

function getPublicCredentials() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  return { url, key };
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getPublicCredentials().url && getPublicCredentials().key);
}

export const hasSupabaseSessionCookie = cache(async () => {
  const cookieStore = await cookies();
  return cookieStore
    .getAll()
    .some((cookie) => cookie.name.startsWith('sb-') && cookie.name.includes('auth-token'));
});

export async function createClient() {
  if (!isSupabaseConfigured()) {
    return createFallbackClient();
  }
  const cookieStore = await cookies();

  const { url, key } = getPublicCredentials();
  return createServerClient<Database>(url!, key!, {
    cookieOptions: supabaseAuthCookieOptions(),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Server Component context
        }
      },
    },
  });
}
