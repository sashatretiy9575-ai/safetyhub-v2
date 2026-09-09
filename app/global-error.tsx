'use client';

import { useEffect, useState } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { AppErrorState } from '@/components/shared/app-state';
import { reportAppError } from '@/lib/observability';
import { BUSINESS_TIME_ZONE, htmlLanguage, type AppLocale } from '@/i18n/config';
import { emergencyLocale } from '@/i18n/emergency-locale';
import ruMessages from '@/messages/global-error/ru.json';
import kkMessages from '@/messages/global-error/kk.json';
import enMessages from '@/messages/global-error/en.json';
import zhMessages from '@/messages/global-error/zh.json';

const MESSAGE_CATALOGS = {
  ru: ruMessages,
  kk: kkMessages,
  en: enMessages,
  zh: zhMessages,
} as const;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<AppLocale>('ru');
  const diagnostic = reportAppError(error, { source: 'global-error', digest: error.digest });
  const messages = MESSAGE_CATALOGS[locale];

  useEffect(() => setLocale(emergencyLocale()), []);

  return (
    <html lang={htmlLanguage(locale)}>
      <body className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-bg)] p-6 text-[var(--color-text)]">
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={BUSINESS_TIME_ZONE}>
          <div className="w-full max-w-2xl">
            <AppErrorState
              title={messages.AppState.criticalTitle}
              description={messages.AppState.criticalDescription}
              diagnostic={diagnostic}
              onRetry={reset}
              retryLabel={messages.Common.retry}
              homeLabel={messages.Common.home}
              correlationLabel={messages.Common.correlationIdPlain}
              compact
            />
            {error.digest ? (
              <p className="mt-4 text-center font-mono text-xs text-[var(--color-text-subtle)]">
                {messages.AppState.digestId}: {error.digest}
              </p>
            ) : null}
          </div>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
