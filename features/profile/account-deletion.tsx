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
import { clearSafetyHubDeviceData } from '@/lib/safetyhub-device-data';

const API_CONFIRMATION = 'DELETE_ACCOUNT';
type PendingDeletionReceipt = {
  pending?: unknown;
  cleanupNotBefore?: unknown;
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
      const receipt = await readClientResponseJson<PendingDeletionReceipt>(result.response);
      if (!result.ok) {
        setMessage(localizedClientRequestMessage(result.error, t('failed'), tErrors));
        return;
      }
      if (receipt?.pending !== true || typeof receipt.cleanupNotBefore !== 'string') {
        setMessage(t('failed'));
        return;
      }
      await clearSafetyHubDeviceData();
      window.location.assign(`${localizePathname('/auth/login', locale)}?deletionRequested=1`);
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
        <h2 className="font-display text-lg font-bold">{t('title')}</h2>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">{t('description')}</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="account-deletion-confirmation">
          {t('prompt', { confirmation: confirmationPhrase })}
        </Label>
        <Input
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
