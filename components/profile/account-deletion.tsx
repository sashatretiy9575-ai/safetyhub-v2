'use client';

import { useState } from 'react';
import { Trash } from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { localizedClientRequestMessage } from '@/i18n/client-errors';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { clearSafetyHubDeviceData } from '@/lib/pwa/device-data';

const API_CONFIRMATION = 'DELETE_ACCOUNT';
type DeletionReceipt = {
  deleted?: unknown;
  error?: unknown;
};

export function AccountDeletion() {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('AccountDeletion');
  const tErrors = useTranslations('Common.errors');
  const confirmationPhrase = t('confirmation');
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const removeAccount = async () => {
    if (busy || confirmation !== confirmationPhrase) return;
    setBusy(true);
    setMessage(t('deleting'));
    try {
      const result = await clientRequest('/api/profile/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmation: API_CONFIRMATION }),
        cache: 'no-store',
      });
      const receipt = await readClientResponseJson<DeletionReceipt>(result.response);
      if (!result.ok) {
        // The two refusals the owner can act on get their own wording; the
        // rest is the generic failure.
        setMessage(
          receipt?.error === 'LAST_ACTIVE_ADMIN_PROTECTED'
            ? t('lastAdmin')
            : receipt?.error === 'ACCOUNT_BUSY'
              ? t('busy')
              : localizedClientRequestMessage(result.error, t('failed'), tErrors),
        );
        return;
      }
      if (receipt?.deleted !== true) {
        setMessage(t('failed'));
        return;
      }
      await clearSafetyHubDeviceData();
      // A full document load, not a router push: the deleted account must not
      // keep any cached segment or client state alive. The absolute URL keeps the
      // navigation on this origin.
      window.location.assign(
        new URL(`${localizePathname('/auth/login', locale)}?accountDeleted=1`, window.location.origin).href,
      );
    } catch (error) {
      setMessage(localizedClientRequestMessage(error, t('failed'), tErrors));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button type="button" size="sm" variant="danger" onClick={() => setOpen(true)}>
        <Trash size={17} /> {t('action')}
      </Button>
    );
  }

  return (
    <div className="space-y-4 border-t border-[var(--color-danger)] pt-4">
      <div>
        {/* Both callers place this inside a section that already has an h2. */}
        <h3 className="font-display text-lg font-bold">{t('title')}</h3>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t('description')}</p>
      </div>
      <div className="space-y-2">
        <Label className="sr-only" htmlFor="account-deletion-confirmation">
          {t('prompt', { confirmation: confirmationPhrase })}
        </Label>
        <Input
          placeholder={t('prompt', { confirmation: confirmationPhrase })}
          id="account-deletion-confirmation"
          value={confirmation}
          onChange={(event) => {
            const val = event.target.value;
            setConfirmation(
              val.trim().toLowerCase() === confirmationPhrase.toLowerCase()
                ? confirmationPhrase
                : val,
            );
          }}
          autoComplete="off"
          disabled={busy}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="danger"
          disabled={busy || confirmation !== confirmationPhrase}
          onClick={removeAccount}
        >
          <Trash size={17} /> {busy ? t('deletingShort') : t('deleteForever')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setConfirmation('');
            setMessage('');
          }}
        >
          {t('cancel')}
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}
    </div>
  );
}
