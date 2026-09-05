import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getMessages, getTranslations, setRequestLocale } from 'next-intl/server';
import { AppShell } from '@/components/layout/app-shell';
import { RootDocument } from '@/components/layout/root-document';
import { JsonLd } from '@/components/shared/json-ld';
import { DeferredPwaInstall } from '@/components/shared/deferred-pwa-install';
import { PublicAccountControl } from '@/components/shared/public-account-control';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { buildMetadata, localBusinessJsonLd, organizationJsonLd, websiteJsonLd } from '@/lib/seo';
import { getSiteContacts } from '@/lib/site-contacts';
import '../globals.css';

export const revalidate = 300;
export const preferredRegion = 'fra1';

export const viewport: Viewport = {
  themeColor: '#f7f8fa',
  colorScheme: 'light dark',
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  setRequestLocale(DEFAULT_LOCALE);
  const metadata = await getTranslations('Metadata');
  return {
    ...buildMetadata({ description: metadata('description'), path: '/', locale: DEFAULT_LOCALE }),
    manifest: '/manifest/ru',
    icons: {
      icon: [
        { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
        { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
      ],
      apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    },
    appleWebApp: {
      capable: true,
      statusBarStyle: 'black-translucent',
      title: 'SafetyHub',
    },
    // Next 15+ emits only `mobile-web-app-capable`; older iOS Safari decides
    // standalone launch by the apple-prefixed meta, so add it explicitly.
    other: { 'apple-mobile-web-app-capable': 'yes' },
    formatDetection: { telephone: false },
  };
}

export default async function PublicLayout({ children }: { children: ReactNode }) {
  setRequestLocale(DEFAULT_LOCALE);
  const [contacts, messages, metadata, footer] = await Promise.all([
    getSiteContacts(),
    getMessages(),
    getTranslations('Metadata'),
    getTranslations('Shell.footer'),
  ]);
  return (
    <RootDocument locale={DEFAULT_LOCALE} messages={messages}>
      <JsonLd
        data={[
          organizationJsonLd(contacts, DEFAULT_LOCALE, {
            description: metadata('description'),
            city: footer('city'),
          }),
          websiteJsonLd(DEFAULT_LOCALE),
          localBusinessJsonLd(contacts, DEFAULT_LOCALE, footer('city')),
        ]}
      />
      <AppShell accountMode="neutral" accountControl={<PublicAccountControl />}>
        {children}
      </AppShell>
      <DeferredPwaInstall />
    </RootDocument>
  );
}
