import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/layout/app-shell';
import { JsonLd } from '@/components/shared/json-ld';
import { DeferredPwaInstall } from '@/components/shared/deferred-pwa-install';
import { PublicAccountControl } from '@/components/shared/public-account-control';
import { localBusinessJsonLd, organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import { getSiteContacts } from '@/lib/site-contacts';
import { setPhysicalLocale } from '../locale-context';

export const revalidate = 300;

/**
 * Localized public shell. Its parent owns the document/locale so this layout
 * stays a pure server component and shares the same static content cache as
 * the unprefixed Russian shell.
 */
export default async function LocalizedPublicLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  setPhysicalLocale((await params).locale);
  const [contacts, locale, metadata, footer] = await Promise.all([
    getSiteContacts(),
    getLocale(),
    getTranslations('Metadata'),
    getTranslations('Shell.footer'),
  ]);
  return (
    <>
      <JsonLd
        data={[
          organizationJsonLd(contacts, locale, {
            description: metadata('description'),
            city: footer('city'),
          }),
          websiteJsonLd(locale),
          localBusinessJsonLd(contacts, locale, footer('city')),
        ]}
      />
      <AppShell accountMode="neutral" accountControl={<PublicAccountControl />}>
        {children}
      </AppShell>
      <DeferredPwaInstall />
    </>
  );
}
