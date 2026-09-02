import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { StaticLegalDocument } from '@/components/legal/static-legal-document';
import {
  getStaticLegalDocument,
  hasLegacyRussianLegalRenderer,
  staticLegalVersions,
} from '@/lib/content/legal-documents';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { resolveLegalDocumentVersion } from '@/lib/legal';
import { buildMetadata } from '@/lib/seo';

export const revalidate = 300;
export const dynamicParams = false;

type TermsVersionPageProps = {
  params: Promise<{ version: string }>;
};

export function generateStaticParams() {
  return staticLegalVersions('terms', DEFAULT_LOCALE).map((version) => ({ version }));
}

export async function generateMetadata({ params }: TermsVersionPageProps) {
  const version = (await params).version;
  const policy = resolveLegalDocumentVersion('terms', version);
  if (
    !policy ||
    (!getStaticLegalDocument('terms', version, DEFAULT_LOCALE) &&
      !hasLegacyRussianLegalRenderer('terms', version))
  ) {
    notFound();
  }

  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: `${t('terms')} ${policy.version}`,
    description: t('termsMetadataDescription'),
    path: `/terms/${encodeURIComponent(policy.version)}`,
    locale: DEFAULT_LOCALE,
  });
}

export default async function TermsVersionPage({ params }: TermsVersionPageProps) {
  const { version } = await params;
  return <StaticLegalDocument type="terms" version={version} locale={DEFAULT_LOCALE} />;
}
