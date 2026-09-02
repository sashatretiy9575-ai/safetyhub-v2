'use client';

import { useEffect, useState } from 'react';
import { LocaleFlag } from '@/components/layout/locale-flag';
import type { AppLocale } from '@/i18n/config';

type LanguageSwitcherComponent =
  typeof import('@/components/layout/language-switcher').LanguageSwitcher;

function LanguageSwitcherFallback({
  locale,
  label,
  languageName,
}: {
  locale: AppLocale;
  label: string;
  languageName: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-label={`${label}: ${languageName}`}
      className="inline-flex h-11 max-w-[10.5rem] items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-sm font-semibold text-[var(--color-text)]"
    >
      <LocaleFlag locale={locale} />
      <span className="min-w-0 truncate">{languageName}</span>
    </button>
  );
}

/**
 * The interactive Radix menu is deferred out of the public LCP bundle.  Its
 * loading state is still a complete, correctly labelled locale control rather
 * than an empty slot, so the header never loses the current flag or language.
 */
export function DeferredLanguageSwitcher({
  locales,
  locale,
  label,
  languageName,
}: {
  locales: readonly AppLocale[];
  locale: AppLocale;
  label: string;
  languageName: string;
}) {
  const [LanguageSwitcher, setLanguageSwitcher] = useState<LanguageSwitcherComponent | null>(null);

  useEffect(() => {
    let active = true;
    void import('@/components/layout/language-switcher').then(({ LanguageSwitcher: Loaded }) => {
      if (active) setLanguageSwitcher(() => Loaded);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!LanguageSwitcher) {
    return <LanguageSwitcherFallback locale={locale} label={label} languageName={languageName} />;
  }

  return <LanguageSwitcher locales={locales} />;
}
