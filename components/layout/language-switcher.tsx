'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from 'next/navigation';
import {
  APP_LOCALES,
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';

const COMPACT_LOCALE_LABELS = {
  ru: 'RU',
  kk: 'KZ',
  en: 'EN',
  zh: '中文',
} as const satisfies Record<AppLocale, string>;

export function LanguageSwitcher() {
  const locale = useLocale();
  const pathname = usePathname();
  const translations = useTranslations('Shell.language');

  const changeLocale = async (nextLocale: AppLocale) => {
    if (nextLocale === locale) return;
    const secure = window.location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${LOCALE_COOKIE_NAME}=${nextLocale}; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    const localizedPathname = localizePathname(pathname, nextLocale);
    const query = window.location.search.slice(1);
    await fetch('/api/profile/locale', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale: nextLocale }),
    }).catch(() => undefined);
    window.location.assign(query ? `${localizedPathname}?${query}` : localizedPathname);
  };

  return (
    <label className="glass inline-flex h-11 shrink-0 items-center rounded-[var(--radius-control)] px-1.5 text-[var(--color-text-muted)]">
      <span className="sr-only">{translations('label')}</span>
      <select
        aria-label={translations('label')}
        value={locale}
        onChange={(event) => void changeLocale(event.target.value as AppLocale)}
        className="h-9 w-14 cursor-pointer appearance-none rounded-lg bg-transparent px-1.5 text-center text-xs font-bold text-[var(--color-text)] outline-none focus-visible:ring-[3px] focus-visible:ring-[var(--color-focus)]/35 min-[1120px]:w-auto min-[1120px]:px-2 min-[1120px]:pr-5 min-[1120px]:text-left"
      >
        {APP_LOCALES.map((candidate) => (
          <option
            key={candidate}
            value={candidate}
            title={translations(candidate)}
            className="bg-[var(--color-surface)]"
          >
            {COMPACT_LOCALE_LABELS[candidate]}
          </option>
        ))}
      </select>
    </label>
  );
}
