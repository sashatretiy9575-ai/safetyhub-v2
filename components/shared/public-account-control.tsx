'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import { AccountIconLink } from '@/components/layout/account-icon-link';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { ROUTES } from '@/lib/constants';

const SESSION_HINT = 'safetyhub-session-hint=1';

const DeferredSignOutAction = dynamic(
  () => import('@/components/shared/sign-out-action').then((module) => module.SignOutAction),
  { ssr: false },
);

function browserHasSafetyHubSessionHint() {
  return document.cookie.split(';').some((cookie) => cookie.trim() === SESSION_HINT);
}

/**
 * This deliberately reads one non-authoritative browser hint only after the
 * static public shell hydrates. It never sends an account request or reads an
 * identity, and cannot change a server cache decision; private pages remain
 * the authority for the actual session and account state.
 */
export function PublicAccountControl() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Shell.account');
  const [hasSessionHint, setHasSessionHint] = useState(false);

  useEffect(() => {
    setHasSessionHint(browserHasSafetyHubSessionHint());
  }, []);

  if (!hasSessionHint) {
    return <AccountIconLink href={localizePathname(ROUTES.signIn, locale)} label={t('guest')} />;
  }

  return (
    <div className="flex items-center gap-2">
      <AccountIconLink href={localizePathname(ROUTES.profile, locale)} label={t('authenticated')} />
      {/* The header is 52 px tall and shared with the language switcher below
          1024 px; sign-out lives on the profile page and in the dock there. */}
      <div className="hidden min-[1024px]:block">
        <DeferredSignOutAction compact />
      </div>
    </div>
  );
}
