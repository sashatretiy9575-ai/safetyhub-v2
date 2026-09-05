import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { RootDocument } from '@/components/layout/root-document';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { absoluteUrl } from '@/lib/utils';
import '../globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(absoluteUrl('/')),
  robots: { index: false, follow: false },
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
  other: { google: 'notranslate', 'apple-mobile-web-app-capable': 'yes' },
};

export default async function AdminGroupLayout({ children }: { children: ReactNode }) {
  setRequestLocale(DEFAULT_LOCALE);
  const messages = await getMessages();
  return (
    <RootDocument locale={DEFAULT_LOCALE} messages={messages}>
      <PWAProvider>{children}</PWAProvider>
    </RootDocument>
  );
}
