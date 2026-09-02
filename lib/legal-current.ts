import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
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
export async function getCurrentLegalPolicies(): Promise<CurrentLegalPolicies> {
  const { data, error } = await createAdminClient()
    .from('legal_document_versions')
    .select('document_type,version,body_revision,effective_at')
    .eq('is_current', true)
    .limit(3);
  if (error || !Array.isArray(data) || data.length !== 2) {
    throw new Error('LEGAL_CURRENT_VERSION_UNAVAILABLE');
  }
  const rows = data as CurrentLegalRow[];
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

export async function resolveActivatedLegalPolicy(
  type: LegalDocumentType,
  requestedVersion?: string,
) {
  if (requestedVersion) return resolveLegalDocumentVersion(type, requestedVersion);
  const current = await getCurrentLegalPolicies();
  return current[type];
}
