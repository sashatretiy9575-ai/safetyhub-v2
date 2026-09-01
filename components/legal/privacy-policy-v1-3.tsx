import privacyPolicyV13 from '@/content/legal/privacy/1.3.ru.json';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import type { LocalizedLegalDocument } from '@/lib/content/legal-documents';
import type { LegalDocumentVersion } from '@/lib/legal';

type PrivacyPolicyV13Props = {
  policy: LegalDocumentVersion;
};

/**
 * Immutable Russian rendering for privacy-1.3. The structured canonical copy
 * is also the deterministic source for the four-locale publication batch.
 */
export function PrivacyPolicyV13({ policy }: PrivacyPolicyV13Props) {
  const document: LocalizedLegalDocument = {
    type: 'privacy',
    version: policy.version,
    locale: 'ru',
    title: privacyPolicyV13.title,
    body: privacyPolicyV13.body,
    bodyHash: privacyPolicyV13.bodySourceSha256,
    effectiveAt: privacyPolicyV13.effectiveAt,
  };
  return <LocalizedLegalDocumentView document={document} />;
}
