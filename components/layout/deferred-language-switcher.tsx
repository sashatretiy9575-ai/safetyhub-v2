'use client';

import { useEffect, useState } from 'react';
import { LocaleFlag } from '@/components/layout/locale-flag';
import { LOCALE_SHORT_LABEL_BY_LOCALE, type AppLocale } from '@/i18n/config';

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
    <div className="relative shrink-0">
      <button
        type="button"
        disabled
        aria-label={`${label}: ${languageName}`}
        className="inline-flex h-11 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-sm font-semibold text-[var(--color-text)]"
      >
        <LocaleFlag locale={locale} />
        <span>{LOCALE_SHORT_LABEL_BY_LOCALE[locale]}</span>
        {/* Holds the 15 px the hydrated trigger's caret occupies, without
            pulling the icon set into the public LCP bundle. */}
        <span aria-hidden="true" className="xs:block hidden size-[15px] shrink-0" />
      </button>
    </div>
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
