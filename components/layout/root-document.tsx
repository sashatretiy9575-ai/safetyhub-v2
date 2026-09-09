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
  // Without a preload the browser only learns about these files after it has
  // fetched and parsed the CSS bundle and found a node that needs them — the
  // third leg of the critical path — so the first paint of every page was
  // system-font text that then reflowed into Manrope.
  if (locale === 'zh') {
    preload('/fonts/noto-sans-sc-ui.da2f47be.woff2', {
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    });
  } else {
    // Latin carries the brand, the numerals and every e-mail address, so it is
    // needed on any page; Cyrillic carries the body text of ru and kk. The
    // extended subsets are deliberately left out: they are rarely reached and a
    // preload would take bandwidth from the LCP image.
    preload('/fonts/manrope-latin.b47b5228.woff2', {
      as: 'font',
      type: 'font/woff2',
      crossOrigin: 'anonymous',
    });
    if (locale === 'ru' || locale === 'kk') {
      preload('/fonts/manrope-cyrillic.d2570ae1.woff2', {
        as: 'font',
        type: 'font/woff2',
        crossOrigin: 'anonymous',
      });
    }
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
