import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { StaticLegalDocument } from '@/components/legal/static-legal-document';
import {
  getStaticLegalDocument,
  hasLegacyRussianLegalRenderer,
  staticLegalVersions,
} from '@/server/content/legal-documents';
import { APP_LOCALES, DEFAULT_LOCALE } from '@/i18n/config';
import { PRIVACY_POLICY, resolveLegalDocumentVersion } from '@/lib/legal';
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
  // The version in force is the same document as /privacy: canonicalise it
  // there rather than competing with it, and keep superseded revisions out of
  // the index while still letting a crawler follow them to the current text.
  const isCurrent = policy.version === PRIVACY_POLICY.version;
  const availableLocales = APP_LOCALES.filter(
    (candidate) =>
      getStaticLegalDocument('privacy', policy.version, candidate) !== null ||
      (candidate === DEFAULT_LOCALE && hasLegacyRussianLegalRenderer('privacy', policy.version)),
  );
  return buildMetadata({
    title: `${t('privacy')} ${policy.version}`,
    description: t('privacyMetadataDescription'),
    path: isCurrent ? '/privacy' : `/privacy/${encodeURIComponent(policy.version)}`,
    noindex: !isCurrent,
    locale: DEFAULT_LOCALE,
    availableLocales,
  });
}

export default async function PrivacyVersionPage({ params }: PrivacyVersionPageProps) {
  const { version } = await params;
  return <StaticLegalDocument type="privacy" version={version} locale={DEFAULT_LOCALE} />;
}
