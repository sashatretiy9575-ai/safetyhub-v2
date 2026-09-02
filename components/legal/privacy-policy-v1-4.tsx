import privacyPolicyV14 from '@/content/legal/privacy/1.4.ru.json';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import type { LocalizedLegalDocument } from '@/lib/content/legal-documents';
import type { LegalDocumentVersion } from '@/lib/legal';

type PrivacyPolicyV14Props = {
  policy: LegalDocumentVersion;
};

/**
 * Immutable Russian rendering for privacy-1.4. This revision accurately
 * describes the data-minimized ZH account without inventing profile data.
 */
export function PrivacyPolicyV14({ policy }: PrivacyPolicyV14Props) {
  const document: LocalizedLegalDocument = {
    type: 'privacy',
    version: policy.version,
    locale: 'ru',
    title: privacyPolicyV14.title,
    body: privacyPolicyV14.body,
    bodyHash: privacyPolicyV14.bodySourceSha256,
    effectiveAt: privacyPolicyV14.effectiveAt,
  };
  return <LocalizedLegalDocumentView document={document} />;
}
