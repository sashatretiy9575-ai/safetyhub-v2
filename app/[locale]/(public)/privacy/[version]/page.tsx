import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { StaticLegalDocument } from '@/components/legal/static-legal-document';
import { getStaticLegalDocument, staticLegalVersions } from '@/lib/content/legal-documents';
import { isAppLocale } from '@/i18n/config';
import { resolveLegalDocumentVersion } from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';
import { setPhysicalLocale } from '../../../locale-context';

export const revalidate = 300;
export const dynamicParams = false;

type Props = {
  params: Promise<{ locale: string; version: string }>;
};

export function generateStaticParams({ params }: { params: { locale: string } }) {
  if (!isAppLocale(params.locale) || params.locale === 'ru') return [];
  return staticLegalVersions('privacy', params.locale).map((version) => ({ version }));
}

export async function generateMetadata({ params }: Props) {
  const { locale: requestedLocale, version } = await params;
  const locale = setPhysicalLocale(requestedLocale);
  const policy = resolveLegalDocumentVersion('privacy', version);
  if (!policy || !getStaticLegalDocument('privacy', version, locale)) notFound();

  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: `${t('privacy')} ${policy.version}`,
    description: t('privacyMetadataDescription'),
    path: `/privacy/${encodeURIComponent(policy.version)}`,
    locale,
  });
}

export default async function LocalizedPrivacyVersionPage({ params }: Props) {
  const { locale: requestedLocale, version } = await params;
  const locale = setPhysicalLocale(requestedLocale);
  return <StaticLegalDocument type="privacy" version={version} locale={locale} />;
}
