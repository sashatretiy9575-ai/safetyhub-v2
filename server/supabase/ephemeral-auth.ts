import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { clientFetch } from '@/lib/client-request';
import type { Database } from '@/lib/supabase/types';

/**
 * Creates a short-lived Auth client for server-side verification of a token
 * received from a user. It intentionally never persists a session; a route
 * must explicitly validate the returned session and copy it into the SSR
 * cookie client only after that validation succeeds.
 */
export function createEphemeralAuthClient(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_NOT_CONFIGURED');
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: { fetch: clientFetch },
  });
}
