import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { getMessages, setRequestLocale } from 'next-intl/server';
import { RootDocument } from '@/components/layout/root-document';
import { PWAProvider } from '@/components/shared/pwa-provider';
import { pickClientNamespaces } from '@/i18n/client-namespaces';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { APP_VIEWPORT, pwaIdentity } from '@/lib/pwa/identity';
import '../globals.css';

// Without this the safe-area insets are zero on these screens, and the
// mobile dock, the sticky header and the install banner all lose the
// spacing they were written against.
export const viewport: Viewport = APP_VIEWPORT;

export const metadata: Metadata = {
  // The (admin) group is its own root layout and none of its twenty-two pages
  // exports metadata, so without this the browser tab had no name at all.
  title: { default: 'Админка SafetyHub', template: '%s — Админка SafetyHub' },
  robots: { index: false, follow: false },
  ...pwaIdentity(),
};

export default async function AdminGroupLayout({ children }: { children: ReactNode }) {
  setRequestLocale(DEFAULT_LOCALE);
  const messages = await getMessages();
  return (
    <RootDocument locale={DEFAULT_LOCALE} messages={pickClientNamespaces(messages)}>
      <PWAProvider>{children}</PWAProvider>
    </RootDocument>
  );
}
