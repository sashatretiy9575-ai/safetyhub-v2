'use client';

import { useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { clientRequest } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import { localizePathname } from '@/i18n/config';
import { clearSafetyHubDeviceData } from '@/lib/pwa/device-data';
import { cn } from '@/lib/utils';

export function SignOutAction({
  menuItem = false,
  compact = false,
  className,
}: {
  /** A menu row: always the short wording — the long one wrapped to three lines in the menu. */
  menuItem?: boolean;
  /** The short wording on a button. Without it the button spells out that the device is cleared too. */
  compact?: boolean;
  className?: string;
}) {
  const locale = useLocale();
  const t = useTranslations('Shell.userMenu');
  const tErrors = useTranslations('Common.errors');
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');
  const label = menuItem || compact ? t('signOutShort') : t('signOut');

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    setError('');
    try {
      const result = await clientRequest('/api/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'local' }),
      });
      if (!result.ok) {
        setError(localizedClientRequestMessage(result.error, t('signOutError'), tErrors));
        return;
      }
      await clearSafetyHubDeviceData();
      window.location.replace(`${localizePathname('/auth/login', locale)}?signedOut=1`);
    } catch (requestError) {
      setError(localizedClientRequestMessage(requestError, t('signOutError'), tErrors));
    } finally {
      setSigningOut(false);
    }
  };

  if (menuItem) {
    return (
      <>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void signOut();
          }}
          disabled={signingOut}
          className={cn(
            'group min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 text-[var(--color-danger)] focus:bg-[var(--color-danger-soft)]',
            className,
          )}
        >
          <SignOut
            size={18}
            weight="regular"
            className="transition-transform group-hover:translate-x-0.5"
          />
          <span className="text-sm font-medium">{signingOut ? t('signingOut') : label}</span>
        </DropdownMenuItem>
        {error ? (
          <p role="alert" className="px-2 pt-2 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={signingOut}
        onClick={() => void signOut()}
        className={cn(
          'border-[var(--color-danger)]/45 text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]',
          className,
        )}
      >
        <SignOut size={17} />
        {signingOut ? t('signingOut') : label}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
