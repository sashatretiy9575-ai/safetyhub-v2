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

type PrivacyVersionPageProps = {
  params: Promise<{ version: string }>;
};

export function generateStaticParams() {
  return staticLegalVersions('privacy', DEFAULT_LOCALE).map((version) => ({ version }));
}

export async function generateMetadata({ params }: PrivacyVersionPageProps) {
  const version = (await params).version;
  const policy = resolveLegalDocumentVersion('privacy', version);
  if (
    !policy ||
    (!getStaticLegalDocument('privacy', version, DEFAULT_LOCALE) &&
      !hasLegacyRussianLegalRenderer('privacy', version))
  ) {
    notFound();
  }

  const t = await getTranslations('LegalFlow');
  return buildMetadata({
    title: `${t('privacy')} ${policy.version}`,
    description: t('privacyMetadataDescription'),
    path: `/privacy/${encodeURIComponent(policy.version)}`,
    locale: DEFAULT_LOCALE,
  });
}

export default async function PrivacyVersionPage({ params }: PrivacyVersionPageProps) {
  const { version } = await params;
  return <StaticLegalDocument type="privacy" version={version} locale={DEFAULT_LOCALE} />;
}
