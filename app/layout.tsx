import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages, getTranslations } from 'next-intl/server';
import { ThemeProvider } from '@/components/shared/theme-provider';
import { PWARegistration } from '@/components/shared/pwa-registration';
import {
  BUSINESS_TIME_ZONE,
  htmlLanguage,
  REQUEST_PATHNAME_HEADER_NAME,
  splitLocalePathname,
} from '@/i18n/config';
import { buildMetadata } from '@/lib/seo';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  const [locale, requestHeaders, translations] = await Promise.all([
    getLocale(),
    headers(),
    getTranslations('Metadata'),
  ]);
  const externalPathname = requestHeaders.get(REQUEST_PATHNAME_HEADER_NAME) ?? '/';
  const pathname = splitLocalePathname(externalPathname).pathname;

  return {
    ...buildMetadata({ description: translations('description'), path: pathname, locale }),
    manifest: `/manifest/${locale}`,
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
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: '#f7f8fa',
  colorScheme: 'light dark',
  viewportFit: 'cover',
};

export const preferredRegion = 'fra1';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <html lang={htmlLanguage(locale)} data-locale={locale} suppressHydrationWarning>
      <head>
        {locale === 'zh' ? (
          <link
            rel="preload"
            href="/fonts/noto-sans-sc-ui.ttf"
            as="font"
            type="font/ttf"
            crossOrigin="anonymous"
          />
        ) : null}
      </head>
      <body className="bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={BUSINESS_TIME_ZONE}>
          <ThemeProvider>
            {children}
            <PWARegistration />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
