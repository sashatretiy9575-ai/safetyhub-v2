import 'server-only';

import { unstable_cache } from 'next/cache';
import { createAdminClient } from '@/server/supabase/admin';
import {
  legalEffectiveDateInAppTimezone,
  resolveLegalDocumentVersion,
  type LegalDocumentType,
  type LegalDocumentVersion,
} from '@/lib/legal';

type CurrentLegalRow = Readonly<{
  document_type: LegalDocumentType;
  version: string;
  body_revision: string;
  effective_at: string;
}>;

export type CurrentLegalPolicies = Readonly<{
  privacy: LegalDocumentVersion;
  terms: LegalDocumentVersion;
}>;

function validatedCurrentPolicy(row: CurrentLegalRow | undefined, type: LegalDocumentType) {
  if (!row || row.document_type !== type) throw new Error('LEGAL_CURRENT_VERSION_MISSING');
  const policy = resolveLegalDocumentVersion(type, row.version);
  if (
    !policy ||
    policy.bodyRevision !== row.body_revision ||
    policy.effectiveDate !== legalEffectiveDateInAppTimezone(row.effective_at)
  ) {
    throw new Error('LEGAL_CURRENT_VERSION_UNSUPPORTED');
  }
  return policy;
}

/**
 * The database is the activation authority. Keeping the application capable
 * of rendering both the old and new immutable copies removes the rolling
 * deployment window in which a compiled pointer could disagree with the
 * version the acceptance RPC considers current.
 */
export const LEGAL_CURRENT_CACHE_TAG = 'legal:current:v1';

// Two rows that change only when an administrator publishes a bundle, read on
// every profile render, legal page and sign-in: cached, invalidated by tag.
const readCurrentLegalRows = unstable_cache(
  async (): Promise<CurrentLegalRow[]> => {
    const { data, error } = await createAdminClient()
      .from('legal_document_versions')
      .select('document_type,version,body_revision,effective_at')
      .eq('is_current', true)
      .limit(3);
    if (error || !Array.isArray(data) || data.length !== 2) {
      throw new Error('LEGAL_CURRENT_VERSION_UNAVAILABLE');
    }
    return data as CurrentLegalRow[];
  },
  ['legal-current-v1'],
  { revalidate: 60 * 60, tags: [LEGAL_CURRENT_CACHE_TAG] },
);

export async function getCurrentLegalPolicies(): Promise<CurrentLegalPolicies> {
  const rows = await readCurrentLegalRows();
  return {
    privacy: validatedCurrentPolicy(
      rows.find((row) => row.document_type === 'privacy'),
      'privacy',
    ),
    terms: validatedCurrentPolicy(
      rows.find((row) => row.document_type === 'terms'),
      'terms',
    ),
  };
}
