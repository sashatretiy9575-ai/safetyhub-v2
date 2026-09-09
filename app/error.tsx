'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Container } from '@/components/ui/container';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { emergencyLocale } from '@/i18n/emergency-locale';
import { reportAppError } from '@/lib/observability';
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

/**
 * Root route error boundary.
 *
 * This runs when a segment throws, which may well be the locale provider's own
 * data, so it takes the same route as `global-error`: the small emergency
 * catalogs and a locale read off the URL. Reaching for the request locale here
 * would make the error screen depend on the thing that just failed, and
 * importing the full dictionary would put 50 KB into a client chunk that only
 * ever renders when something is broken. The copy used to be English on every
 * locale.
 */
export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const diagnostic = reportAppError(error, { source: 'route-error' });
  const [locale, setLocale] = useState<AppLocale>('ru');
  const messages = MESSAGE_CATALOGS[locale];

  useEffect(() => setLocale(emergencyLocale()), []);

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div
        className="mx-auto w-full max-w-xl space-y-5 rounded-3xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-6 shadow-[var(--shadow-soft)]"
        role="alert"
      >
        <div className="space-y-2">
          <h1 className="font-display text-2xl font-semibold">{messages.AppState.errorTitle}</h1>
          <p className="text-sm text-[var(--color-text-muted)]">
            {messages.AppState.errorDescription}
          </p>
          <p className="font-mono text-xs break-all text-[var(--color-text-subtle)]">
            {messages.Common.correlationIdPlain}: {diagnostic.correlationId}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button type="button" onClick={reset}>
            {messages.Common.retry}
          </Button>
          <Button asChild variant="outline">
            <Link href={localizePathname('/', locale)}>{messages.Common.home}</Link>
          </Button>
        </div>
      </div>
    </Container>
  );
}
