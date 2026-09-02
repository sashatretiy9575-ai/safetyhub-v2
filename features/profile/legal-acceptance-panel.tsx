'use client';

import { useMemo, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { legalDocumentHref, type LegalDocumentVersion, type LegalDocumentType } from '@/lib/legal';
import type { Json, LegalAcceptanceRow } from '@/lib/supabase/types';
import { localizePathname, type AppLocale } from '@/i18n/config';

type Acceptance = Omit<LegalAcceptanceRow, 'user_id'>;

type LegalAcceptancePanelProps = {
  initialAcceptances: Acceptance[];
  initiallyUnavailable: boolean;
  currentPolicies: Readonly<{
    privacy: LegalDocumentVersion;
    terms: LegalDocumentVersion;
  }>;
  onAccepted?: () => void;
};

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

function localizedDocumentHref(type: LegalDocumentType, version: string, locale: AppLocale) {
  const href = legalDocumentHref(type, version);
  const [pathnameAndQuery, fragment] = href.split('#', 2);
  const [pathname, query] = pathnameAndQuery?.split('?', 2) ?? [];
  const localized = localizePathname(pathname ?? '/', locale);
  return `${localized}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
}

export function LegalAcceptancePanel({
  initialAcceptances,
  initiallyUnavailable,
  currentPolicies,
  onAccepted,
}: LegalAcceptancePanelProps) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('LegalFlow');
  const format = useFormatter();
  const [acceptances, setAcceptances] = useState(initialAcceptances);
  const [historyUnavailable, setHistoryUnavailable] = useState(initiallyUnavailable);
  const [confirmed, setConfirmed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const currentDocuments = useMemo(
    () => [currentPolicies.privacy, currentPolicies.terms] as const,
    [currentPolicies],
  );

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
        setMessage(t('saveFailed'));
        return;
      }
      const recorded = parseAcceptancePayload(data);
      const recordedKeys = new Set(recorded.map((acceptance) => acceptanceKey(acceptance)));
      // The RPC returns the immutable acceptance history, not only the pair
      // written by this request. Existing users can therefore legitimately
      // receive older accepted versions in addition to the current pair.
      if (
        !currentDocuments.every((document) =>
          recordedKeys.has(`${document.type}:${document.version}`),
        )
      ) {
        setMessage(t('receiptMissing'));
        return;
      }
      setAcceptances((current) => mergeAcceptances(current, recorded));
      setHistoryUnavailable(false);
      setConfirmed(true);
      setMessage(t('saved'));
      onAccepted?.();
    } catch {
      setMessage(t('networkFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="font-display text-xl font-bold">{t('title')}</h2>
        <p className="text-sm text-[var(--color-text-muted)]">{t('description')}</p>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--color-text-muted)]">
        <span className="font-medium text-[var(--color-text)]">{t('documentsEyebrow')}:</span>
        {currentDocuments.map((document, index) => (
          <span key={document.type} className="inline-flex items-center gap-1">
            {index > 0 ? <span aria-hidden="true">·</span> : null}
            <Link
              href={localizedDocumentHref(document.type, document.version, locale)}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-[var(--color-primary)] underline underline-offset-2"
            >
              {t(document.type)}
            </Link>
            <span className="text-xs">{document.version}</span>
          </span>
        ))}
      </p>

      {historyUnavailable ? (
        <p
          role="alert"
          className="flex gap-2 rounded-[var(--radius-control)] bg-[var(--color-surface-muted)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
        >
          <WarningCircle aria-hidden="true" className="mt-0.5 shrink-0" size={17} />
          {t('historyUnavailable')}
        </p>
      ) : null}

      {!currentAccepted ? (
        <form onSubmit={acceptCurrent} className="flex flex-wrap items-center gap-3">
          <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 text-xs leading-5 text-[var(--color-text-muted)]">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-[var(--color-primary)]"
              required
            />
            <span>
              {t('confirmation', {
                privacyVersion: currentPolicies.privacy.version,
                termsVersion: currentPolicies.terms.version,
              })}
            </span>
          </label>
          <Button type="submit" size="sm" disabled={!confirmed || busy}>
            {busy ? t('saving') : t('accept')}
          </Button>
        </form>
      ) : (
        <p className="flex items-center gap-2 text-sm font-medium text-[var(--color-primary)]">
          <CheckCircle aria-hidden="true" size={18} weight="fill" />
          {t('acceptedCurrent')}
        </p>
      )}

      {message ? (
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-text-muted)]">
          {message}
        </p>
      ) : null}

      {acceptances.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
            {t('history')}
          </summary>
          <ul className="mt-2 divide-y divide-[var(--color-border)]">
            {acceptances.map((acceptance) => (
              <li
                key={acceptanceKey(acceptance)}
                className="flex flex-col gap-1 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
              >
                <span>
                  <strong className="text-[var(--color-text)]">
                    {t(acceptance.document_type)} {acceptance.version}
                  </strong>
                  <span className="block text-xs text-[var(--color-text-muted)]">
                    {Number.isNaN(Date.parse(acceptance.accepted_at))
                      ? t('dateUnavailable')
                      : `${format.dateTime(new Date(acceptance.accepted_at), {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })} (${t('timezone')})`}{' '}
                    ·{' '}
                    {acceptance.source === 'registration'
                      ? t('sourceRegistration')
                      : t('sourceProfile')}
                  </span>
                </span>
                <Link
                  href={localizedDocumentHref(acceptance.document_type, acceptance.version, locale)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-9 shrink-0 items-center font-medium text-[var(--color-primary)] underline underline-offset-2"
                >
                  {t('openAccepted')}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
