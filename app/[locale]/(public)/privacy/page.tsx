import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { LocalizedLegalDocumentView } from '@/components/legal/localized-legal-document';
import { getStaticLegalDocument } from '@/lib/content/legal-documents';
import { PRIVACY_POLICY } from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';
import { setPhysicalLocale } from '../../locale-context';

export const revalidate = 300;

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  const locale = setPhysicalLocale((await params).locale);
  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: t('privacy'),
    description: t('privacyMetadataDescription'),
    path: '/privacy',
    locale,
  });
}

export default async function LocalizedPrivacyPage({ params }: Props) {
  const locale = setPhysicalLocale((await params).locale);
  const document = getStaticLegalDocument('privacy', PRIVACY_POLICY.version, locale);
  if (!document) notFound();
  return <LocalizedLegalDocumentView document={document} />;
}
