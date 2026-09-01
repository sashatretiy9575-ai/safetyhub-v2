import termsPolicyV23 from '@/content/legal/terms/2.3.ru.json';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import type { LocalizedLegalDocument } from '@/lib/content/legal-documents';
import type { LegalDocumentVersion } from '@/lib/legal';

type TermsPolicyV23Props = {
  policy: LegalDocumentVersion;
};

/**
 * Immutable Russian rendering for terms-2.3. The structured canonical copy is
 * shared with the deterministic service-only localization import artifacts.
 */
export function TermsPolicyV23({ policy }: TermsPolicyV23Props) {
  const document: LocalizedLegalDocument = {
    type: 'terms',
    version: policy.version,
    locale: 'ru',
    title: termsPolicyV23.title,
    body: termsPolicyV23.body,
    bodyHash: termsPolicyV23.bodySourceSha256,
    effectiveAt: termsPolicyV23.effectiveAt,
  };
  return <LocalizedLegalDocumentView document={document} />;
}
