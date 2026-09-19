'use client';
import { useState } from 'react';
import type { DocumentProfile } from '@/lib/pdf/document-profile';
import { clientFetch } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type ProfileFieldsProps = {
  profile: DocumentProfile;
  onSaved(profile: DocumentProfile): void;
};
/** What is typed here. Who signs, and with which image, is never edited in this form. */
type ProfileText = ReturnType<typeof textOf>;

function textOf({
  programName,
  hours,
  validityMonths,
  orderNumber,
  orderDate,
  verificationKind,
  protocolText,
  decisionText,
}: DocumentProfile) {
  return {
    programName,
    hours,
    validityMonths,
    orderNumber,
    orderDate,
    verificationKind,
    protocolText,
    decisionText,
  };
}

const sameText = (a: ProfileText, b: ProfileText) => JSON.stringify(a) === JSON.stringify(b);

/** A field the administrator has not touched follows the stored profile; a touched one keeps what was typed. */
function follow(draft: ProfileText, base: ProfileText, stored: ProfileText) {
  return Object.fromEntries(
    (Object.keys(stored) as (keyof ProfileText)[]).map((key) => [
      key,
      draft[key] === base[key] ? stored[key] : draft[key],
    ]),
  ) as ProfileText;
}

/**
 * The requisites of one program. The form keeps this mounted for as long as the
 * same profile is open (`key={profile.id}`), while the profile itself moves
 * under it: replacing a signature in «Подписи и печать» rebinds every profile
 * and raises its revision. So the bindings and the revision are always the
 * stored ones, from `profile`, and only the text lives here.
 */
export function DocumentProfileFieldsBody({ profile, onSaved }: ProfileFieldsProps) {
  const stored = textOf(profile);
  const [base, setBase] = useState(stored);
  const [draft, setDraft] = useState(stored);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  if (!sameText(base, stored)) {
    // Saved here, or by another administrator before a replacement re-read the profiles.
    setBase(stored);
    setDraft(follow(draft, base, stored));
  }
  const text = (
    key: 'programName' | 'orderNumber' | 'orderDate' | 'verificationKind',
    label: string,
  ) => (
    <label className="grid min-w-0 gap-1 text-sm">
      {label}
      <Input
        value={draft[key]}
        type={key === 'orderDate' ? 'date' : 'text'}
        onChange={(e) => setDraft((v) => ({ ...v, [key]: e.target.value }))}
      />
    </label>
  );
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const response = await clientFetch('/api/admin/documents/profiles', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: { ...profile, ...draft },
          expectedVersion: profile.revision ?? 1,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? 'Профиль изменён. Обновите страницу.'
            : 'Проверьте реквизиты программы.',
        );
        return;
      }
      // The saved text comes back as `profile`; what was typed meanwhile stays typed.
      onSaved(result.profile);
      setMessage('Сохранено для новых выдач.');
    } catch {
      setMessage('Не удалось сохранить профиль.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-3">
      {text('programName', 'Программа')}
      <div className="xs:grid-cols-2 grid min-w-0 gap-2">
        <label className="grid min-w-0 gap-1 text-sm">
          Часы
          <Input
            type="number"
            min={1}
            max={5000}
            value={draft.hours ?? ''}
            onChange={(e) =>
              setDraft((v) => ({ ...v, hours: e.target.value ? Number(e.target.value) : null }))
            }
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm">
          Срок, месяцев
          <Input
            type="number"
            min={0}
            max={120}
            value={draft.validityMonths}
            onChange={(e) => setDraft((v) => ({ ...v, validityMonths: Number(e.target.value) }))}
          />
        </label>
      </div>
      <p className="text-sm text-[var(--color-text-muted)]">0 — срок не указан</p>
      {profile.family === 'biot' ? (
        <>
          {text('orderNumber', 'Номер приказа')}
          {text('orderDate', 'Дата приказа')}
          {text('verificationKind', 'Вид проверки знаний')}
        </>
      ) : null}
      <label className="grid min-w-0 gap-1 text-sm">
        Основание проверки
        <Textarea
          value={draft.protocolText}
          onChange={(e) => setDraft((v) => ({ ...v, protocolText: e.target.value }))}
        />
      </label>
      <label className="grid min-w-0 gap-1 text-sm">
        Решение комиссии
        <Textarea
          value={draft.decisionText}
          onChange={(e) => setDraft((v) => ({ ...v, decisionText: e.target.value }))}
        />
      </label>
      <ul aria-label="Комиссия" className="grid min-w-0 gap-3">
        {profile.commission.map((person, place) => (
          // One person may hold two seats; the order of a commission is what is fixed.
          <li
            key={place}
            className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1 text-sm"
          >
            <div className="min-w-0 break-words">
              <p className="text-[var(--color-text-muted)]">
                {place === 0 ? 'Председатель' : 'Член комиссии'}
              </p>
              <p className="font-medium">{person.name}</p>
              {person.position ? (
                <p className="text-[var(--color-text-muted)]">{person.position}</p>
              ) : null}
            </div>
            <p
              className={cn(
                'shrink-0',
                person.assetId ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]',
              )}
            >
              {person.assetId ? 'Подпись есть' : 'Подписи нет'}
            </p>
          </li>
        ))}
      </ul>
      <Button
        className="h-auto min-h-12 min-w-0 whitespace-normal"
        type="button"
        disabled={busy}
        onClick={save}
      >
        Сохранить профиль
      </Button>
      {/* The line is there before the answer is: saving moves nothing. */}
      <p role="status" className="min-h-5 text-sm break-words">
        {message}
      </p>
    </div>
  );
}

/**
 * The name the form has always mounted. There is no frame of its own around the
 * fields any more — a `Section` of the form brings the heading and the divider —
 * so the two names are one component.
 */
export const DocumentProfileFields = DocumentProfileFieldsBody;
