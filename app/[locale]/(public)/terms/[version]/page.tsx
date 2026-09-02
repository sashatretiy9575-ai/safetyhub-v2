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
  return staticLegalVersions('terms', params.locale).map((version) => ({ version }));
}

export async function generateMetadata({ params }: Props) {
  const { locale: requestedLocale, version } = await params;
  const locale = setPhysicalLocale(requestedLocale);
  const policy = resolveLegalDocumentVersion('terms', version);
  if (!policy || !getStaticLegalDocument('terms', version, locale)) notFound();

  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: `${t('terms')} ${policy.version}`,
    description: t('termsMetadataDescription'),
    path: `/terms/${encodeURIComponent(policy.version)}`,
    locale,
  });
}

export default async function LocalizedTermsVersionPage({ params }: Props) {
  const { locale: requestedLocale, version } = await params;
  const locale = setPhysicalLocale(requestedLocale);
  return <StaticLegalDocument type="terms" version={version} locale={locale} />;
}
