import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import { getStaticLegalDocument } from '@/server/content/legal-documents';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { TERMS_POLICY } from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';

export const revalidate = 300;

export async function generateMetadata() {
  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: t('terms'),
    description: t('termsMetadataDescription'),
    path: '/terms',
    locale: DEFAULT_LOCALE,
  });
}

/** See the privacy route for why current legal copies are static local reads. */
export default function TermsPage() {
  const document = getStaticLegalDocument('terms', TERMS_POLICY.version, DEFAULT_LOCALE);
  if (!document) notFound();
  return <LocalizedLegalDocumentView document={document} />;
}
