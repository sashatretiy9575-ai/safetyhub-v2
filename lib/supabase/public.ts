import 'server-only';

import { createClient } from '@supabase/supabase-js';
import { contentUpstreamFetch } from '@/lib/content/upstream';
import type { Database } from './types';

export function createPublicClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;

  return createClient<Database>(url, key, {
    global: { fetch: contentUpstreamFetch },
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
