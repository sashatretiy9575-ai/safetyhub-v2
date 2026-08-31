'use client';

import { useMemo, useState } from 'react';
import { CheckCircle, FileText, WarningCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import {
  legalDocumentHref,
  PRIVACY_POLICY,
  TERMS_POLICY,
  type LegalDocumentType,
} from '@/lib/legal';
import type { Json, LegalAcceptanceRow } from '@/lib/supabase/types';

type Acceptance = Omit<LegalAcceptanceRow, 'user_id'>;

type LegalAcceptancePanelProps = {
  initialAcceptances: Acceptance[];
  initiallyUnavailable: boolean;
  onAccepted?: () => void;
};

const currentDocuments = [PRIVACY_POLICY, TERMS_POLICY] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAcceptancePayload(value: Json | null): Acceptance[] {
  if (!isRecord(value) || !Array.isArray(value.acceptances)) return [];
  return value.acceptances.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const documentType = candidate.documentType;
    const version = candidate.version;
    const acceptedAt = candidate.acceptedAt;
    const source = candidate.source;
    if (
      (documentType !== 'privacy' && documentType !== 'terms') ||
      typeof version !== 'string' ||
      typeof acceptedAt !== 'string' ||
      (source !== 'registration' && source !== 'profile')
    ) {
      return [];
    }
    return [
      {
        document_type: documentType,
        version,
        accepted_at: acceptedAt,
        source,
      },
    ];
  });
}

function acceptanceKey(acceptance: Acceptance) {
  return `${acceptance.document_type}:${acceptance.version}`;
}

function mergeAcceptances(current: Acceptance[], incoming: Acceptance[]) {
  const merged = new Map(current.map((acceptance) => [acceptanceKey(acceptance), acceptance]));
  incoming.forEach((acceptance) => merged.set(acceptanceKey(acceptance), acceptance));
  return [...merged.values()].sort(
    (left, right) => Date.parse(right.accepted_at) - Date.parse(left.accepted_at),
  );
}

function documentLabel(type: LegalDocumentType) {
  return type === 'privacy' ? 'Политика конфиденциальности' : 'Условия использования';
}

function acceptedAtLabel(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return 'дата недоступна';
  return `${new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Almaty',
  }).format(timestamp)} (Алматы)`;
}

export function LegalAcceptancePanel({
  initialAcceptances,
  initiallyUnavailable,
  onAccepted,
}: LegalAcceptancePanelProps) {
  const [acceptances, setAcceptances] = useState(initialAcceptances);
  const [historyUnavailable, setHistoryUnavailable] = useState(initiallyUnavailable);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const acceptedKeys = useMemo(
    () => new Set(acceptances.map((acceptance) => acceptanceKey(acceptance))),
    [acceptances],
  );
  const currentAccepted = currentDocuments.every((document) =>
    acceptedKeys.has(`${document.type}:${document.version}`),
  );

  const acceptCurrent = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirmed || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await clientRequest('/api/profile/legal-acceptances', {
        method: 'POST',
      });
      const data = await readClientResponseJson<Json>(result.response);
      if (!result.ok) {
        setMessage('Не удалось записать согласие. Обновите страницу и попробуйте ещё раз.');
        return;
      }
      const recorded = parseAcceptancePayload(data);
      const recordedKeys = new Set(recorded.map((acceptance) => acceptanceKey(acceptance)));
      if (
        recorded.length !== currentDocuments.length ||
        !currentDocuments.every((document) =>
          recordedKeys.has(`${document.type}:${document.version}`),
        )
      ) {
        setMessage('Сервер не вернул подтверждение записи. Обновите страницу перед повтором.');
        return;
      }
      setAcceptances((current) => mergeAcceptances(current, recorded));
      setHistoryUnavailable(false);
      setConfirmed(false);
      setMessage('Текущие версии приняты. Запись добавлена в историю.');
      onAccepted?.();
    } catch {
      setMessage('Не удалось записать согласие. Проверьте соединение и попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 shrink-0 text-[var(--color-primary)]" size={22} />
        <div className="space-y-1">
          <h2 className="font-display text-xl font-bold">Документы и согласия</h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            Здесь хранится версия, которую вы приняли. Ссылка открывает именно эту редакцию.
          </p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {currentDocuments.map((document) => {
          const accepted = acceptedKeys.has(`${document.type}:${document.version}`);
          return (
            <div
              key={document.type}
              className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3"
            >
              <p className="text-sm font-semibold text-[var(--color-text)]">{document.title}</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                Текущая версия {document.version}
              </p>
              <Link
                href={legalDocumentHref(document.type, document.version)}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-flex min-h-11 items-center font-semibold text-[var(--color-primary)] underline underline-offset-2"
              >
                Открыть документ
              </Link>
              <p className="flex items-center gap-1 text-xs">
                {accepted ? (
                  <>
                    <CheckCircle
                      aria-hidden="true"
                      size={16}
                      className="text-[var(--color-primary)]"
                    />
                    Принята
                  </>
                ) : (
                  'Ещё не принята'
                )}
              </p>
            </div>
          );
        })}
      </div>

      {historyUnavailable ? (
        <p
          role="alert"
          className="flex gap-2 rounded-xl border border-dashed border-[var(--color-warning)] p-3 text-sm text-[var(--color-text-muted)]"
        >
          <WarningCircle aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
          История согласий временно недоступна. Документы можно открыть, но перед повторным
          принятием лучше обновить страницу.
        </p>
      ) : null}

      {!currentAccepted ? (
        <form onSubmit={acceptCurrent} className="space-y-3 rounded-xl border p-4">
          <label className="flex cursor-pointer items-start gap-3 text-sm leading-5">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 size-5 shrink-0 accent-[var(--color-primary)]"
              required
            />
            <span>
              Я прочитал(а) и принимаю Политику конфиденциальности версии {PRIVACY_POLICY.version} и
              Условия использования версии {TERMS_POLICY.version}.
            </span>
          </label>
          <Button type="submit" size="sm" disabled={!confirmed || busy}>
            {busy ? 'Сохраняем…' : 'Принять текущие версии'}
          </Button>
        </form>
      ) : (
        <p className="flex items-center gap-2 rounded-xl bg-[var(--color-primary-soft)] p-3 text-sm font-semibold text-[var(--color-primary)]">
          <CheckCircle aria-hidden="true" size={18} weight="fill" />
          Текущие версии приняты.
        </p>
      )}

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}

      {acceptances.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-bold">История принятия</h3>
          <ul className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] px-3">
            {acceptances.map((acceptance) => (
              <li
                key={acceptanceKey(acceptance)}
                className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <span>
                  <strong className="text-[var(--color-text)]">
                    {documentLabel(acceptance.document_type)} {acceptance.version}
                  </strong>
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    {acceptedAtLabel(acceptance.accepted_at)} ·{' '}
                    {acceptance.source === 'registration' ? 'при регистрации' : 'в профиле'}
                  </span>
                </span>
                <Link
                  href={legalDocumentHref(acceptance.document_type, acceptance.version)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 shrink-0 items-center font-semibold text-[var(--color-primary)] underline underline-offset-2"
                >
                  Открыть принятую версию
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
