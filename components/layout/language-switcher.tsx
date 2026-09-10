'use client';

import { useState } from 'react';
import { CaretDown } from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LocaleFlag } from '@/components/layout/locale-flag';
import { clearSafetyHubDeviceData } from '@/lib/safetyhub-device-data';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import {
  LOCALE_COOKIE_MAX_AGE,
  LOCALE_COOKIE_NAME,
  LOCALE_SHORT_LABEL_BY_LOCALE,
  isAppLocale,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';

type LocaleTransitionResult =
  | { state: 'updated'; locale: AppLocale; redirectTo: string }
  | { state: 'signed_out'; locale: AppLocale; redirectTo: string };

const SESSION_HINT = 'safetyhub-session-hint';
const ACTIVE_QUIZ_ROUTE = /^\/(?:kk\/|en\/|zh\/)?topics\/[^/]+\/test(?:\/|$)/u;

function hasSessionHint() {
  return document.cookie.split(';').some((cookie) => cookie.trim() === SESSION_HINT + '=1');
}

function setLocalePreference(locale: AppLocale) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    LOCALE_COOKIE_NAME +
    '=' +
    locale +
    '; Path=/; Max-Age=' +
    LOCALE_COOKIE_MAX_AGE +
    '; SameSite=Lax' +
    secure;
}

function navigationTarget(pathname: string, locale: AppLocale) {
  const localizedPathname = localizePathname(pathname, locale);
  return window.location.search ? localizedPathname + window.location.search : localizedPathname;
}

function isTransitionResult(value: unknown): value is LocaleTransitionResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<LocaleTransitionResult>;
  return (
    (candidate.state === 'updated' || candidate.state === 'signed_out') &&
    isAppLocale(candidate.locale) &&
    typeof candidate.redirectTo === 'string' &&
    /^\/(?!\/)/u.test(candidate.redirectTo)
  );
}

/**
 * The selector intentionally uses the non-authoritative session hint instead
 * of a client Supabase read. Guests only navigate. Authenticated transitions
 * are resolved by the server, which owns the realm boundary and cookie cleanup.
 */
export function LanguageSwitcher({ locales }: { locales: readonly AppLocale[] }) {
  const locale = useLocale() as AppLocale;
  const router = useRouter();
  const pathname = usePathname();
  const translations = useTranslations('Shell.language');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const quizLocked = ACTIVE_QUIZ_ROUTE.test(pathname);

  /**
   * Soft navigation keeps the already-loaded application shell and fetches only
   * the new server payload. The signed-out branch stays a hard navigation
   * because the server has just dropped the auth cookies and the next document
   * must be requested with the new cookie jar.
   */
  const openLocale = (target: string) => {
    router.replace(target);
    router.refresh();
  };

  const changeLocale = async (nextLocale: AppLocale) => {
    if (!locales.includes(nextLocale) || nextLocale === locale || pending) return;
    if (quizLocked) {
      setStatus(translations('quizLocked'));
      return;
    }

    setStatus('');
    // A guest language change is a URL/preference change only. It must never
    // hit an authenticated profile endpoint or cause a stray 401.
    //
    // It is also a plain route change, so it goes through the App Router rather
    // than `location.assign`: a full document load re-downloaded the HTML, the
    // CSS and every chunk, which is what made switching feel slow.
    if (!hasSessionHint()) {
      setLocalePreference(nextLocale);
      openLocale(navigationTarget(pathname, nextLocale));
      return;
    }

    setPending(true);
    try {
      const result = await clientRequest('/api/profile/locale', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: nextLocale }),
      });
      if (!result.ok) throw new Error('LOCALE_TRANSITION_FAILED');
      const payload: unknown = await readClientResponseJson<unknown>(result.response).catch(
        () => null,
      );
      if (!isTransitionResult(payload) || payload.locale !== nextLocale) {
        throw new Error('LOCALE_TRANSITION_FAILED');
      }

      setLocalePreference(nextLocale);
      if (payload.state === 'signed_out') {
        // The server has already cleared auth cookies. This fills browser gaps
        // before opening the target realm and does not clear unrelated origin
        // state such as Cloudflare or Turnstile cookies.
        await clearSafetyHubDeviceData();
        setStatus(translations('sessionEnded'));
        window.location.assign(payload.redirectTo);
        return;
      }

      openLocale(navigationTarget(pathname, nextLocale));
      setPending(false);
    } catch {
      // Do not open a target realm over an active old-realm session if the
      // server cleanup/transition request was unavailable.
      setStatus(translations('switchError'));
      setPending(false);
    }
  };

  return (
    <div className="relative shrink-0">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${translations('label')}: ${translations(locale)}`}
            aria-describedby={status ? 'language-switcher-status' : undefined}
            disabled={pending}
            className="inline-flex h-11 items-center gap-1 rounded-[var(--radius-control)] px-1.5 text-sm font-semibold text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-muted)] focus-visible:outline focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)] disabled:cursor-wait disabled:opacity-60"
          >
            <LocaleFlag locale={locale} />
            {/* The flag plus the short code is the whole visible control; the
                full language name stays in the accessible label and the menu.
                The caret is the one thing the 320 px header can do without. */}
            <span>{LOCALE_SHORT_LABEL_BY_LOCALE[locale]}</span>
            <CaretDown
              size={15}
              weight="bold"
              className="hidden shrink-0 text-[var(--color-text-subtle)] min-[340px]:block"
              aria-hidden="true"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[12.25rem] p-1">
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => {
              if (isAppLocale(value)) void changeLocale(value);
            }}
            aria-label={translations('label')}
          >
            {locales.map((candidate) => (
              <DropdownMenuRadioItem
                key={candidate}
                value={candidate}
                disabled={pending || quizLocked}
                // The owner wants one label per language: the flag and the short
                // code, as in the trigger. The full name stays the accessible name.
                aria-label={translations(candidate)}
                className="min-h-11 gap-2.5 py-2.5 pr-4 text-[var(--color-text)] data-[state=checked]:bg-[var(--color-primary-soft)] data-[state=checked]:font-semibold"
              >
                <LocaleFlag locale={candidate} />
                <span>{LOCALE_SHORT_LABEL_BY_LOCALE[candidate]}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {quizLocked ? (
            <p className="px-2.5 pt-2 pb-1 text-xs leading-4 text-[var(--color-text-subtle)]">
              {translations('quizLocked')}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <p id="language-switcher-status" role="status" aria-live="polite" className="sr-only">
        {pending ? translations('switching') : status}
      </p>
    </div>
  );
}
