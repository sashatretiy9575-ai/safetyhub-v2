import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import type { AbstractIntlMessages } from 'next-intl';
import { NextIntlClientProvider } from 'next-intl';
import { ThemeProvider } from '@/components/shared/theme-provider';
import { PWARegistration } from '@/components/shared/pwa-registration';
import { PWA_INSTALL_BOOTSTRAP } from '@/lib/pwa-install-bootstrap';
import { BUSINESS_TIME_ZONE, htmlLanguage, type AppLocale } from '@/i18n/config';

/**
 * Shared document shell for the separate public and private App Router roots.
 * Keeping the locale in the physical route tree means the public roots can be
 * generated and cached without consulting request headers or user cookies.
 */
export function RootDocument({
  children,
  locale,
  messages,
}: {
  children: ReactNode;
  locale: AppLocale;
  messages: AbstractIntlMessages;
}) {
  if (locale === 'zh') {
    preload('/fonts/noto-sans-sc-ui.f113fe63.woff2', {
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    });
  }

  return (
    <html
      lang={htmlLanguage(locale)}
      data-locale={locale}
      translate="no"
      className="notranslate"
      suppressHydrationWarning
    >
      <body className="bg-[var(--color-bg)] text-[var(--color-text)] antialiased">
        {/* Parks `beforeinstallprompt` before any React chunk loads. The event
            fires once and cannot be replayed, so catching it later meant the
            install banner appeared or vanished depending on how the page was
            entered. It only stores the event; the banner itself stays lazy. */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: PWA_INSTALL_BOOTSTRAP }}
        />
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
