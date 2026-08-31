import 'server-only';

import { cache } from 'react';
import { unstable_cache } from 'next/cache';
import { createPublicClient } from '@/lib/supabase/public';
import {
  coerceSiteContactSettings,
  type SiteContactSettings,
} from '@/lib/site-contacts-shared';

export const SITE_CONTACTS_CACHE_TAG = 'site:contacts:v1';
export const SITE_CONTACTS_REVALIDATE_SECONDS = 60 * 60;

// SAFETYHUB_GLOBAL_CONTACTS: the only hardcoded production-safe contact fallback.
// Public pages render this value if Supabase is unavailable or the cache is cold.
export const FALLBACK_SITE_CONTACTS: SiteContactSettings = Object.freeze({
  phoneE164: '+77017290349',
  phoneDisplay: '+7 701 729 0349',
  whatsappE164: '+77017290349',
  whatsappSameAsPhone: true,
  version: 0,
  updatedAt: null,
  updatedBy: null,
});

type RpcResult = { data: unknown; error: { message?: string } | null };
type RpcClient = { rpc(name: string): PromiseLike<RpcResult> };

let lastKnownSiteContacts: SiteContactSettings = FALLBACK_SITE_CONTACTS;

export async function readSiteContactsUncached(): Promise<SiteContactSettings> {
  const client = createPublicClient();
  if (!client) return lastKnownSiteContacts;

  try {
    const { data, error } = await (client as unknown as RpcClient).rpc('get_site_settings');
    if (error) return lastKnownSiteContacts;
    const parsed = coerceSiteContactSettings(data);
    if (!parsed) return lastKnownSiteContacts;
    lastKnownSiteContacts = parsed;
    return parsed;
  } catch {
    return lastKnownSiteContacts;
  }
}

const getCachedSiteContacts = unstable_cache(
  readSiteContactsUncached,
  ['site-contacts-v1'],
  {
    revalidate: SITE_CONTACTS_REVALIDATE_SECONDS,
    tags: [SITE_CONTACTS_CACHE_TAG],
  },
);

export const getSiteContacts = cache(getCachedSiteContacts);
