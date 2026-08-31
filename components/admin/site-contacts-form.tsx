'use client';

import { useMemo, useState } from 'react';
import { CheckCircle, Phone, Warning, WhatsappLogo } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  formatPhoneDisplay,
  normalizePhoneE164,
  type SiteContactSettings,
} from '@/lib/site-contacts-shared';

const PHONE_ERROR_ID = 'site-contacts-phone-error';
const WHATSAPP_ERROR_ID = 'site-contacts-whatsapp-error';

export function SiteContactsForm({ initialSettings }: { initialSettings: SiteContactSettings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [phone, setPhone] = useState(initialSettings.phoneDisplay);
  const [whatsapp, setWhatsapp] = useState(initialSettings.whatsappE164);
  const [same, setSame] = useState(initialSettings.whatsappSameAsPhone);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error' | 'conflict'>('idle');
  const [message, setMessage] = useState('');

  const phoneE164 = useMemo(() => normalizePhoneE164(phone), [phone]);
  const whatsappE164 = useMemo(
    () => normalizePhoneE164(same ? phone : whatsapp),
    [phone, same, whatsapp],
  );
  const valid = Boolean(phoneE164 && whatsappE164);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid || state === 'saving') return;
    setState('saving');
    setMessage('');
    try {
      const response = await fetch('/api/admin/settings/contacts', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          phone,
          whatsapp: same ? phone : whatsapp,
          whatsappSameAsPhone: same,
          expectedVersion: settings.version,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: string; settings?: SiteContactSettings }
        | null;
      if (response.status === 409 && payload?.settings) {
        setSettings(payload.settings);
        setPhone(payload.settings.phoneDisplay);
        setWhatsapp(payload.settings.whatsappE164);
        setSame(payload.settings.whatsappSameAsPhone);
        setState('conflict');
        setMessage('Другой администратор уже изменил контакты. Показаны актуальные значения.');
        return;
      }
      if (!response.ok || !payload?.settings) throw new Error(payload?.error ?? 'SAVE_FAILED');

      setSettings(payload.settings);
      setPhone(payload.settings.phoneDisplay);
      setWhatsapp(payload.settings.whatsappE164);
      setSame(payload.settings.whatsappSameAsPhone);
      setState('saved');
      setMessage('Контакты сохранены.');
    } catch {
      setState('error');
      setMessage('Не удалось сохранить контакты. Проверьте соединение и повторите.');
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} className="space-y-6">
      <div className="grid gap-5 md:grid-cols-2">
        <label className="space-y-2">
          <span className="flex items-center gap-2 text-sm font-bold">
            <Phone size={18} aria-hidden="true" /> Телефон
          </span>
          <Input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            aria-describedby={phone.length > 0 && !phoneE164 ? PHONE_ERROR_ID : undefined}
            onChange={(event) => {
              setPhone(event.target.value);
              setState('idle');
            }}
            invalid={phone.length > 0 && !phoneE164}
            placeholder="+7 701 729 0349"
            required
          />
          {phone.length > 0 && !phoneE164 ? (
            <span
              id={PHONE_ERROR_ID}
              role="alert"
              className="block text-xs text-[var(--color-danger)]"
            >
              Проверьте номер
            </span>
          ) : null}
        </label>

        <div className="space-y-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[var(--color-border)] px-3 text-sm font-bold">
            <input
              type="checkbox"
              checked={same}
              onChange={(event) => {
                setSame(event.target.checked);
                setState('idle');
              }}
              className="size-5 accent-[var(--color-primary)]"
            />
            WhatsApp совпадает с телефоном
          </label>
          <label className="block space-y-2">
            <span className="flex items-center gap-2 text-sm font-bold">
              <WhatsappLogo size={18} aria-hidden="true" /> WhatsApp
            </span>
            <Input
              type="tel"
              inputMode="tel"
              value={same ? phone : whatsapp}
              aria-describedby={
                !same && whatsapp.length > 0 && !whatsappE164
                  ? WHATSAPP_ERROR_ID
                  : undefined
              }
              onChange={(event) => {
                setWhatsapp(event.target.value);
                setState('idle');
              }}
              disabled={same}
              invalid={!same && whatsapp.length > 0 && !whatsappE164}
              required={!same}
            />
            {!same && whatsapp.length > 0 && !whatsappE164 ? (
              <span
                id={WHATSAPP_ERROR_ID}
                role="alert"
                className="block text-xs text-[var(--color-danger)]"
              >
                Проверьте номер
              </span>
            ) : null}
          </label>
        </div>
      </div>

      {valid ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          На сайте: <strong className="text-[var(--color-text)]">{formatPhoneDisplay(phoneE164!)}</strong>
          {' · '}WhatsApp: <strong className="text-[var(--color-text)]">{formatPhoneDisplay(whatsappE164!)}</strong>
        </p>
      ) : null}

      {message ? (
        <div
          role="status"
          className={`flex gap-2 rounded-xl border p-3 text-sm ${
            state === 'saved'
              ? 'border-[var(--color-success)]/35 bg-[var(--color-success)]/10'
              : 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10'
          }`}
        >
          {state === 'saved' ? <CheckCircle size={20} /> : <Warning size={20} />}
          <span>{message}</span>
        </div>
      ) : null}

      <div className="flex justify-end border-t border-[var(--color-border)] pt-5">
        <Button type="submit" disabled={!valid || state === 'saving'} className="w-full sm:w-auto">
          {state === 'saving' ? 'Сохраняем…' : 'Сохранить контакты'}
        </Button>
      </div>
    </form>
  );
}
