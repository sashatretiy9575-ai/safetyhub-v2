'use client';

import { useEffect, useState } from 'react';
import { Container } from '@/components/ui/container';
import { Button } from '@/components/ui/button';
import { htmlLanguage, localizePathname, type AppLocale } from '@/i18n/config';
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

/**
 * The body of the root 404.
 *
 * It sits outside every locale layout, so there is no request locale and no
 * provider — the same situation `global-error` is in, and it uses the same
 * four-key emergency catalogs rather than pulling a 50 KB dictionary into a
 * client chunk. The copy used to be English on every locale.
 *
 * The document element belongs to the wrapper Next generates for the root
 * `not-found`, so the language is set on it rather than rendered; without that
 * the page announced itself as having no language at all.
 */
export function NotFoundNotice() {
  const [locale, setLocale] = useState<AppLocale>('ru');
  const messages = MESSAGE_CATALOGS[locale];

  useEffect(() => {
    const resolved = emergencyLocale();
    setLocale(resolved);
    document.documentElement.lang = htmlLanguage(resolved);
  }, []);

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <div className="space-y-4">
        <p className="font-mono text-sm tracking-widest text-[var(--color-text-muted)] uppercase">
          404
        </p>
        <h1 className="font-display text-3xl font-semibold">{messages.AppState.notFoundTitle}</h1>
        <p className="text-[var(--color-text-muted)]">{messages.AppState.notFoundDescription}</p>
        <Button asChild>
          <a href={localizePathname('/', locale)}>{messages.Common.home}</a>
        </Button>
      </div>
    </Container>
  );
}
