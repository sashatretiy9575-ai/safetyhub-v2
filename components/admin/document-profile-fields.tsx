'use client';
import { useState } from 'react';
import type { DocumentProfile } from '@/lib/pdf/document-profile';
import { registeredDocumentAssetUrl } from '@/lib/pdf/document-profile';
import { clientFetch } from '@/lib/client-request';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function DocumentProfileFields({
  profile,
  onSaved,
}: {
  profile: DocumentProfile;
  onSaved(profile: DocumentProfile): void;
}) {
  const [draft, setDraft] = useState(profile);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
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
        body: JSON.stringify({ profile: draft, expectedVersion: profile.revision ?? 1 }),
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
      setDraft(result.profile);
      onSaved(result.profile);
      setMessage('Сохранено для новых выдач.');
    } catch {
      setMessage('Не удалось сохранить профиль.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="rounded-xl border p-3">
      <summary className="min-h-11 cursor-pointer py-2 text-base font-medium">
        Реквизиты программы и комиссия
      </summary>
      <div className="mt-3 grid gap-3">
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
        <p className="text-sm text-[var(--color-text-muted)]">
          0 — срок не указан; не означает бессрочный допуск.
        </p>
        {draft.family === 'biot' ? (
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
        {draft.commission.map((person) => (
          <div
            key={person.signerId}
            className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span>
              {person.name}
              <br />
              <small>{person.position}</small>
            </span>
            {person.assetId ? (
              <a
                className="underline"
                href={registeredDocumentAssetUrl(person.assetId)}
                target="_blank"
                rel="noreferrer"
              >
                Подпись PNG
              </a>
            ) : (
              <span>Подпись не подтверждена</span>
            )}
          </div>
        ))}
        {draft.stampAssetId ? (
          <a
            className="text-sm underline"
            href={registeredDocumentAssetUrl(draft.stampAssetId)}
            target="_blank"
            rel="noreferrer"
          >
            Печать PNG
          </a>
        ) : null}
        <Button
          className="h-auto min-h-12 min-w-0 whitespace-normal"
          type="button"
          disabled={busy}
          onClick={save}
        >
          Сохранить профиль
        </Button>
        {message ? (
          <p role="status" className="text-sm">
            {message}
          </p>
        ) : null}
      </div>
    </details>
  );
}
