import { notFound } from 'next/navigation';
import { PrivacyPolicyV11 } from '@/app/(public)/privacy/page';
import { TermsPolicyV21 } from '@/app/(public)/terms/page';
import { TermsPolicyV22 } from '@/components/legal/terms-policy-v2-2';
import { PrivacyPolicyV12 } from '@/components/legal/privacy-policy-v1-2';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import {
  getStaticLegalDocument,
  hasLegacyRussianLegalRenderer,
} from '@/lib/content/legal-documents';
import { resolveLegalDocumentVersion, type LegalDocumentType } from '@/lib/legal';
import type { AppLocale } from '@/i18n/config';

type StaticLegalDocumentProps = {
  type: LegalDocumentType;
  version: string;
  locale: AppLocale;
};

/**
 * Renders an immutable document selected by a physical versioned route. The
 * local loader intentionally wins; the two early Russian copies retain their
 * audited React renderers because they predate structured localization bodies.
 */
export function StaticLegalDocument({ type, version, locale }: StaticLegalDocumentProps) {
  const document = getStaticLegalDocument(type, version, locale);
  if (document) return <LocalizedLegalDocumentView document={document} />;

  const policy = resolveLegalDocumentVersion(type, version);
  if (!policy || locale !== 'ru' || !hasLegacyRussianLegalRenderer(type, version)) notFound();

  if (policy.bodyRevision === 'privacy-1.1') return <PrivacyPolicyV11 policy={policy} />;
  if (policy.bodyRevision === 'privacy-1.2') return <PrivacyPolicyV12 policy={policy} />;
  if (policy.bodyRevision === 'terms-2.1') return <TermsPolicyV21 policy={policy} />;
  if (policy.bodyRevision === 'terms-2.2') return <TermsPolicyV22 policy={policy} />;

  notFound();
}
