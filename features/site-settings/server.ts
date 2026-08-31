import 'server-only';

import { revalidatePath, revalidateTag } from 'next/cache';
import { requireCapability } from '@/features/auth/server';
import { SITE_CONTACTS_CACHE_TAG } from '@/lib/site-contacts';
import {
  coerceSiteContactSettings,
  formatPhoneDisplay,
  normalizePhoneE164,
  type SiteContactSettings,
} from '@/lib/site-contacts-shared';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

type RpcError = { message: string; code?: string };
type RpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

export type UpdateSiteContactsInput = {
  phone: string;
  whatsapp: string;
  whatsappSameAsPhone: boolean;
  expectedVersion: number;
};

export class SiteContactsConflictError extends Error {
  constructor() {
    super('SITE_SETTINGS_VERSION_CONFLICT');
  }
}

export async function updateSiteContacts(
  input: UpdateSiteContactsInput,
): Promise<SiteContactSettings> {
  await requireCapability('site.settings.manage');
  const phoneE164 = normalizePhoneE164(input.phone);
  const requestedWhatsapp = input.whatsappSameAsPhone ? input.phone : input.whatsapp;
  const whatsappE164 = normalizePhoneE164(requestedWhatsapp);
  if (!phoneE164 || !whatsappE164 || !Number.isSafeInteger(input.expectedVersion)) {
    throw new Error('SITE_SETTINGS_INVALID');
  }

  const client = (await createClient()) as unknown as RpcClient;
  const response = await client.rpc('update_site_settings', {
    p_phone_e164: phoneE164,
    p_phone_display: formatPhoneDisplay(phoneE164),
    p_whatsapp_e164: whatsappE164,
    p_whatsapp_same_as_phone: input.whatsappSameAsPhone,
    p_expected_version: input.expectedVersion,
  });
  let payload: unknown;
  try {
    payload = unwrapRpcMutationResponse(response);
  } catch (mutationError) {
    if (
      mutationError instanceof Error &&
      mutationError.message.includes('SITE_SETTINGS_VERSION_CONFLICT')
    ) {
      throw new SiteContactsConflictError();
    }
    throw mutationError;
  }
  const settings = coerceSiteContactSettings(payload);
  if (!settings) throw new Error('SITE_SETTINGS_RESPONSE_INVALID');

  revalidateTag(SITE_CONTACTS_CACHE_TAG, { expire: 0 });
  for (const path of ['/', '/contacts', '/privacy', '/terms', '/faq']) {
    revalidatePath(path);
  }
  return settings;
}
