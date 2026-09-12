import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { StaticLegalDocument } from '@/components/legal/static-legal-document';
import {
  getStaticLegalDocument,
  hasLegacyRussianLegalRenderer,
  staticLegalVersions,
} from '@/server/content/legal-documents';
import { APP_LOCALES, DEFAULT_LOCALE } from '@/i18n/config';
import { TERMS_POLICY, resolveLegalDocumentVersion } from '@/lib/legal';
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
  // The version in force is the same document as /terms: canonicalise it
  // there rather than competing with it, and keep superseded revisions out of
  // the index while still letting a crawler follow them to the current text.
  const isCurrent = policy.version === TERMS_POLICY.version;
  const availableLocales = APP_LOCALES.filter(
    (candidate) =>
      getStaticLegalDocument('terms', policy.version, candidate) !== null ||
      (candidate === DEFAULT_LOCALE && hasLegacyRussianLegalRenderer('terms', policy.version)),
  );
  return buildMetadata({
    title: `${t('terms')} ${policy.version}`,
    description: t('termsMetadataDescription'),
    path: isCurrent ? '/terms' : `/terms/${encodeURIComponent(policy.version)}`,
    noindex: !isCurrent,
    locale: DEFAULT_LOCALE,
    availableLocales,
  });
}

export default async function TermsVersionPage({ params }: TermsVersionPageProps) {
  const { version } = await params;
  return <StaticLegalDocument type="terms" version={version} locale={DEFAULT_LOCALE} />;
}
