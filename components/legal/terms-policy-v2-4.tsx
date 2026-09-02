import termsPolicyV24 from '@/content/legal/terms/2.4.ru.json';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import type { LocalizedLegalDocument } from '@/lib/content/legal-documents';
import type { LegalDocumentVersion } from '@/lib/legal';

type TermsPolicyV24Props = {
  policy: LegalDocumentVersion;
};

/**
 * Immutable Russian rendering for terms-2.4. This revision aligns the
 * published legal/UI record with the minimal ZH username-and-password flow.
 */
export function TermsPolicyV24({ policy }: TermsPolicyV24Props) {
  const document: LocalizedLegalDocument = {
    type: 'terms',
    version: policy.version,
    locale: 'ru',
    title: termsPolicyV24.title,
    body: termsPolicyV24.body,
    bodyHash: termsPolicyV24.bodySourceSha256,
    effectiveAt: termsPolicyV24.effectiveAt,
  };
  return <LocalizedLegalDocumentView document={document} />;
}
