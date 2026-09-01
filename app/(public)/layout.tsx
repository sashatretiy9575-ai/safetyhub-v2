import type { ReactNode } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { AppShell } from '@/components/layout/app-shell';
import { JsonLd } from '@/components/shared/json-ld';
import { PWAInstallOverlay } from '@/components/shared/pwa-install-overlay';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { localBusinessJsonLd, organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import { getSiteContacts } from '@/lib/site-contacts';

export default async function PublicLayout({ children }: { children: ReactNode }) {
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
      <AppShell accountMode="neutral">{children}</AppShell>
      <PWAProvider>
        <PWAInstallOverlay />
      </PWAProvider>
    </>
  );
}
