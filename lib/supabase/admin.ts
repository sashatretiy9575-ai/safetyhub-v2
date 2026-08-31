import 'server-only';

import { createClient } from '@supabase/supabase-js';
import type { Database } from './types';

export function createAdminClient() {
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !secret) {
    throw new Error(
      'Supabase admin is not configured. Add NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY to .env.local',
    );
  }
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    secret,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  );
}
