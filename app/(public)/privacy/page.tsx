import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import { getStaticLegalDocument } from '@/server/content/legal-documents';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { PRIVACY_POLICY } from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';

export const revalidate = 300;

export async function generateMetadata() {
  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: t('privacy'),
    description: t('privacyMetadataDescription'),
    path: '/privacy',
    locale: DEFAULT_LOCALE,
  });
}

/**
 * The unversioned public URL is deliberately a local immutable read. Historical
 * versions have physical `/privacy/:version` routes, so neither a session cookie
 * nor a query string can make this CDN response viewer-specific.
 */
export default function PrivacyPage() {
  const document = getStaticLegalDocument('privacy', PRIVACY_POLICY.version, DEFAULT_LOCALE);
  if (!document) notFound();
  return <LocalizedLegalDocumentView document={document} />;
}
