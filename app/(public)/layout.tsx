import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/app-shell';
import { JsonLd } from '@/components/shared/json-ld';
import { PWAInstallOverlay } from '@/components/shared/pwa-install-overlay';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { localBusinessJsonLd, organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import { getSiteContacts } from '@/lib/site-contacts';

export default async function PublicLayout({ children }: { children: ReactNode }) {
  const contacts = await getSiteContacts();
  return (
    <>
      <JsonLd
        data={[organizationJsonLd(contacts), websiteJsonLd(), localBusinessJsonLd(contacts)]}
      />
      <AppShell accountMode="neutral">{children}</AppShell>
      <PWAProvider>
        <PWAInstallOverlay />
      </PWAProvider>
    </>
  );
}
