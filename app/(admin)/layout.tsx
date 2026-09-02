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
  other: { google: 'notranslate' },
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
