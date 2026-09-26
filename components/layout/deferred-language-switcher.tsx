'use client';

import { useState } from 'react';
import { LocaleFlag } from '@/components/layout/locale-flag';
import { LANGUAGE_TRIGGER_CLASS } from '@/components/layout/language-switcher-trigger';
import { LOCALE_SHORT_LABEL_BY_LOCALE, type AppLocale } from '@/i18n/config';

type LanguageSwitcherComponent =
  typeof import('@/components/layout/language-switcher').LanguageSwitcher;

let switcherModule: Promise<LanguageSwitcherComponent> | undefined;
function loadLanguageSwitcher() {
  switcherModule ??= import('@/components/layout/language-switcher').then(
    (module) => module.LanguageSwitcher,
  );
  return switcherModule;
}

type Intent = { open: boolean; focus: boolean };

function LanguageSwitcherFallback({
  locale,
  label,
  languageName,
  onIntent,
}: {
  locale: AppLocale;
  label: string;
  languageName: string;
  onIntent: (intent: Partial<Intent>) => void;
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={false}
        aria-label={`${label}: ${languageName}`}
        onPointerEnter={() => onIntent({})}
        onTouchStart={() => onIntent({})}
        onFocus={() => onIntent({ focus: true })}
        onClick={() => onIntent({ open: true })}
        className={LANGUAGE_TRIGGER_CLASS}
      >
        <LocaleFlag locale={locale} />
        <span>{LOCALE_SHORT_LABEL_BY_LOCALE[locale]}</span>
        {/* Holds the 15 px the loaded trigger's caret occupies, without
            pulling the icon set into the public LCP bundle. */}
        <span aria-hidden="true" className="xs:block hidden size-[15px] shrink-0" />
      </button>
    </div>
  );
}

/**
 * The Radix menu (about 35 KB of JavaScript) is loaded when someone reaches for
 * the control — hover, touch, focus or a click — not after every page load, when
 * almost nobody opens it. The placeholder is the same trigger, fully labelled;
 * a click that arrives before the chunk opens the menu as soon as it lands, and
 * keyboard focus moves onto the loaded trigger.
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
  const [intent, setIntent] = useState<Intent>({ open: false, focus: false });

  const reachFor = (next: Partial<Intent>) => {
    setIntent((current) => ({ ...current, ...next }));
    void loadLanguageSwitcher().then((Loaded) => setLanguageSwitcher(() => Loaded));
  };

  if (!LanguageSwitcher) {
    return (
      <LanguageSwitcherFallback
        locale={locale}
        label={label}
        languageName={languageName}
        onIntent={reachFor}
      />
    );
  }

  return (
    <LanguageSwitcher locales={locales} defaultOpen={intent.open} autoFocusTrigger={intent.focus} />
  );
}
