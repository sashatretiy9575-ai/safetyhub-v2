'use client';

import { useEffect, useState } from 'react';
import { buttonClassName } from '@/components/ui/button-classes';
import { EMERGENCY_CONTAINER } from '@/components/ui/container-classes';
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
 * client chunk. This chunk loads with every route, so it draws its button from
 * plain class strings instead of the `Button`/`Container` components: through
 * them it carried its own copies of cva, Radix Slot, tailwind-merge and
 * next/link into every page.
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
    <div className={`${EMERGENCY_CONTAINER} grid min-h-[60vh] place-items-center py-16 text-center`}>
      {/* The metadata of the root 404 never reaches the document Next builds
          for it, so the tab was left without a name; React hoists this one. */}
      <title>{`${messages.AppState.notFoundTitle} — SafetyHub`}</title>
      <div className="space-y-4">
        <p className="font-mono text-sm tracking-widest text-[var(--color-text-muted)] uppercase">
          404
        </p>
        <h1 className="font-display text-h2 font-semibold">{messages.AppState.notFoundTitle}</h1>
        <p className="text-[var(--color-text-muted)]">{messages.AppState.notFoundDescription}</p>
        <a href={localizePathname('/', locale)} className={buttonClassName()}>
          {messages.Common.home}
        </a>
      </div>
    </div>
  );
}
