'use client';

import { useEffect, useRef, useState } from 'react';
import { Buildings } from '@phosphor-icons/react/dist/csr/Buildings';
import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { FloppyDisk } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type { AdminAttestationRow } from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { formatDateTime } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertificateDownloadButton } from '@/features/certificates/download-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LearningHistoryControl } from '@/components/admin/learning-history-control';

export type AttestationPermissions = {
  canReadUser: boolean;
  canReadIdentity: boolean;
  canReadCertificate: boolean;
  canManageIdentity: boolean;
  canIssue: boolean;
  canRevoke: boolean;
  canExport: boolean;
  canDeleteHistory: boolean;
};

type CertificateHistoryItem = {
  id: string;
  certificateNumber: string;
  score: number;
  total: number;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

export type AttestationPendingAction =
  | { kind: 'confirm' }
  | { kind: 'bulk-update'; field: 'job' | 'organization' }
  | {
      kind: 'individual-update';
      row: AdminAttestationRow;
      field: 'name' | 'surname' | 'job' | 'organization';
    }
  | { kind: 'issue' }
  | { kind: 'revoke' }
  | { kind: 'export' }
  | { kind: 'bulk-delete' };

export type AttestationSelectionSummary = {
  total: number;
  people: number;
  pendingIdentity: number;
  readyToIssue: number;
  issued: number;
  exportable: number;
};

const identityLabels: Record<AdminAttestationRow['identityState'], string> = {
  pending: 'Ожидает проверки',
  verified: 'Подтверждено',
  changed: 'Данные изменены',
  revoked: 'Подтверждение отозвано',
};

const certificateLabels: Record<AdminAttestationRow['certificateState'], string> = {
  not_eligible: 'Не сдан',
  pending_identity: 'Ожидает проверки',
  ready: 'Готов к выдаче',
  issued: 'Выдан',
  revoked: 'Отозван',
};

export const attestationFieldLabels = {
  name: 'Имя',
  surname: 'Фамилия',
  job: 'Должность',
  organization: 'Компания',
} as const;

export type AttestationIdentityFields = {
  name: string;
  surname: string;
  job: string;
  organization: string;
};

function identityVariant(state: AdminAttestationRow['identityState']): BadgeProps['variant'] {
  if (state === 'verified') return 'success';
  if (state === 'changed') return 'warning';
  if (state === 'revoked') return 'danger';
  return 'outline';
}

function certificateVariant(state: AdminAttestationRow['certificateState']): BadgeProps['variant'] {
  if (state === 'issued') return 'success';
  if (state === 'ready') return 'primary';
  if (state === 'revoked' || state === 'not_eligible') return 'danger';
  return 'warning';
}

function workflowStatus(row: AdminAttestationRow) {
  if (row.identityState !== 'verified') {
    return {
      label: identityLabels[row.identityState],
      variant: identityVariant(row.identityState),
    };
  }
  return {
    label: certificateLabels[row.certificateState],
    variant: certificateVariant(row.certificateState),
  };
}

export function AttestationWorkflowBadge({ row }: { row: AdminAttestationRow }) {
  const status = workflowStatus(row);
  return (
    <span className="flex flex-wrap gap-1">
      <Badge variant={status.variant}>{status.label}</Badge>
      {row.courseDeleted ? <Badge variant="outline">Курс удалён</Badge> : null}
    </span>
  );
}

function initials(row: AdminAttestationRow) {
  return `${row.name[0] ?? ''}${row.surname[0] ?? ''}`.toLocaleUpperCase('ru-RU') || '—';
}

function ProfileAvatar({
  row,
  canReadIdentity,
}: {
  row: AdminAttestationRow;
  canReadIdentity: boolean;
}) {
  const src = `/api/admin/attestations/avatar/${row.userId}`;
  return (
    <Avatar className="size-24 rounded-2xl">
      {row.avatarAvailable && canReadIdentity ? (
        <AvatarImage
          src={src}
          alt={`Фото: ${row.fullName}`}
          className="rounded-2xl object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <AvatarFallback className="rounded-2xl text-xl">{initials(row)}</AvatarFallback>
    </Avatar>
  );
}

export function AttestationRowActions({
  row,
  permissions,
  openDetails,
  openAction,
}: {
  row: AdminAttestationRow;
  permissions: AttestationPermissions;
  openDetails: () => void;
  openAction: (action: AttestationPendingAction) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`Действия: ${row.fullName}`}>
          <DotsThree size={22} weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={openDetails}>Открыть сведения</DropdownMenuItem>
        {permissions.canManageIdentity && !row.courseDeleted ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openDetails}>Исправить данные</DropdownMenuItem>
          </>
        ) : null}
        {permissions.canIssue &&
        !row.courseDeleted &&
        (row.certificateState === 'ready' || row.certificateState === 'revoked') ? (
          <DropdownMenuItem onSelect={() => openAction({ kind: 'issue' })}>
            {row.certificateState === 'revoked' ? 'Выдать повторно' : 'Выдать сертификат'}
          </DropdownMenuItem>
        ) : null}
        {permissions.canRevoke && row.certificateId && row.certificateState === 'issued' ? (
          <DropdownMenuItem
            className="text-[var(--color-danger)]"
            onSelect={() => openAction({ kind: 'revoke' })}
          >
            Отозвать сертификат
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AttestationBulkActionButtons({
  summary,
  permissions,
  busy,
  onAction,
  onClear,
  compact = false,
}: {
  summary: AttestationSelectionSummary;
  permissions: AttestationPermissions;
  busy: boolean;
  onAction: (action: AttestationPendingAction) => void;
  onClear: () => void;
  compact?: boolean;
}) {
  const issueLabel = `Выдать ${summary.readyToIssue}`;
  const confirmLabel = `Подтвердить ${summary.pendingIdentity}`;

  return (
    <div className={compact ? 'grid gap-2' : 'flex flex-wrap items-center gap-2'}>
      {permissions.canManageIdentity ? (
        <>
          <Button
            size={compact ? 'md' : 'sm'}
            variant="outline"
            disabled={summary.pendingIdentity === 0}
            onClick={() => onAction({ kind: 'confirm' })}
            className={compact ? 'w-full justify-start' : undefined}
          >
            <CheckCircle /> {confirmLabel}
          </Button>
          <Button
            size={compact ? 'md' : 'sm'}
            variant="outline"
            disabled={summary.people === 0}
            onClick={() => onAction({ kind: 'bulk-update', field: 'organization' })}
            className={compact ? 'w-full justify-start' : undefined}
          >
            <Buildings /> Изменить компанию ({summary.people})
          </Button>
        </>
      ) : null}
      {permissions.canIssue ? (
        <Button
          size={compact ? 'md' : 'sm'}
          disabled={summary.readyToIssue === 0}
          onClick={() => onAction({ kind: 'issue' })}
          className={compact ? 'w-full justify-start' : undefined}
        >
          {issueLabel}
        </Button>
      ) : null}
      {permissions.canRevoke ? (
        <Button
          size={compact ? 'md' : 'sm'}
          variant="danger"
          disabled={summary.issued === 0}
          onClick={() => onAction({ kind: 'revoke' })}
          className={compact ? 'w-full justify-start' : undefined}
        >
          Отозвать {summary.issued}
        </Button>
      ) : null}
      {permissions.canManageIdentity || permissions.canDeleteHistory ? (
        <Button
          size={compact ? 'md' : 'sm'}
          variant="danger"
          disabled={summary.people === 0}
          onClick={() => onAction({ kind: 'bulk-delete' })}
          className={compact ? 'w-full justify-start' : undefined}
        >
          <Trash /> Удалить пользователей ({summary.people})
        </Button>
      ) : null}
      {permissions.canExport ? (
        <Button
          size={compact ? 'md' : 'sm'}
          variant="outline"
          disabled={busy}
          onClick={() => onAction({ kind: 'export' })}
          className={compact ? 'w-full justify-start' : undefined}
        >
          <DownloadSimple /> ZIP ({summary.exportable})
        </Button>
      ) : null}
      <Button
        size={compact ? 'md' : 'sm'}
        variant="ghost"
        onClick={onClear}
        className={compact ? 'w-full justify-start' : undefined}
      >
        Снять выделение
      </Button>
    </div>
  );
}

function AttestationIdentityForm({
  row,
  onSaved,
}: {
  row: AdminAttestationRow;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
}) {
  const [fields, setFields] = useState<AttestationIdentityFields>({
    name: row.name,
    surname: row.surname,
    job: row.job,
    organization: row.organization,
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  const update =
    (field: keyof AttestationIdentityFields) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setFields((current) => ({ ...current, [field]: event.target.value }));

  const save = async () => {
    if (busy) return;
    const normalized = {
      name: fields.name.trim(),
      surname: fields.surname.trim(),
      job: fields.job.trim(),
      organization: fields.organization.trim(),
    };
    if (Object.values(normalized).some((value) => value.length < 2)) {
      setFailed(true);
      setMessage('Заполните все четыре поля — минимум по два символа.');
      return;
    }

    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      const result = await clientRequest(`/api/admin/users/${row.userId}/identity`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'verify', ...normalized }),
      });
      const payload = await readClientResponseJson<{ status?: string; error?: string }>(
        result.response,
      );
      if (!result.ok) {
        setFailed(true);
        setMessage(clientRequestMessage(result.error, 'Не удалось сохранить данные.'));
        return;
      }
      if (!payload?.status) {
        setFailed(true);
        setMessage('Сервер вернул неполный ответ. Обновите страницу и проверьте данные.');
        return;
      }
      setFields(normalized);
      setMessage('Данные сохранены и подтверждены.');
      onSaved(row, normalized);
    } catch (error) {
      setFailed(true);
      setMessage(clientRequestMessage(error, 'Не удалось сохранить данные.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t pt-4">
      <div>
        <h3 className="text-base font-bold">Исправить данные</h3>
        <p className="mt-1 text-xs text-[var(--color-text-muted)]">
          Измените нужные поля и сохраните один раз. Данные будут подтверждены для сертификата.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(attestationFieldLabels) as Array<keyof AttestationIdentityFields>).map(
          (field) => (
            <div key={field} className="space-y-1">
              <Label htmlFor={`attestation-${field}-${row.userId}`}>
                {attestationFieldLabels[field]}
              </Label>
              <Input
                id={`attestation-${field}-${row.userId}`}
                value={fields[field]}
                onChange={update(field)}
                autoComplete="off"
              />
            </div>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          <FloppyDisk /> {busy ? 'Сохраняем…' : 'Сохранить данные'}
        </Button>
        {message ? (
          <p
            role={failed ? 'alert' : 'status'}
            className={
              failed
                ? 'text-xs text-[var(--color-danger)]'
                : 'text-xs text-[var(--color-text-muted)]'
            }
          >
            {message}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function AttestationDetailDrawer({
  row,
  permissions,
  onClose,
  onSaved,
  onHistoryDeleted,
}: {
  row: AdminAttestationRow | null;
  permissions: AttestationPermissions;
  onClose: () => void;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
  onHistoryDeleted: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [history, setHistory] = useState<
    | {
        state: 'idle' | 'loading' | 'failed';
        email: string | null;
        items: CertificateHistoryItem[];
      }
    | { state: 'ready'; email: string | null; items: CertificateHistoryItem[] }
  >({ state: 'idle', email: null, items: [] });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (row && dialog && !dialog.open) dialog.showModal();
    if (!row && dialog?.open) dialog.close();
  }, [row]);

  useEffect(() => {
    if (
      !row ||
      row.courseDeleted ||
      !row.testId ||
      row.testVersion === null ||
      !permissions.canReadCertificate ||
      !permissions.canReadUser
    ) {
      setHistory({ state: 'idle', email: null, items: [] });
      return;
    }
    const controller = new AbortController();
    setHistory({ state: 'loading', email: null, items: [] });
    void (async () => {
      const params = new URLSearchParams({
        testId: row.testId!,
        testVersion: String(row.testVersion!),
      });
      const result = await clientRequest(
        `/api/admin/attestations/history/${row.userId}?${params}`,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const payload = await readClientResponseJson<{
        email?: string | null;
        items?: CertificateHistoryItem[];
      }>(result.response);
      if (!result.ok || !payload?.items) {
        setHistory({ state: 'failed', email: null, items: [] });
        return;
      }
      setHistory({ state: 'ready', email: payload.email ?? null, items: payload.items });
    })().catch(() => {
      if (!controller.signal.aborted) setHistory({ state: 'failed', email: null, items: [] });
    });
    return () => controller.abort();
  }, [permissions.canReadCertificate, permissions.canReadUser, row]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (row) onClose();
      }}
      className="mt-0 mr-0 mb-0 h-dvh max-h-none w-[min(38rem,100vw)] max-w-none border-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/45"
    >
      {row ? (
        <div className="flex min-h-full flex-col">
          <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b bg-[var(--color-surface)] p-4">
            <div className="min-w-0">
              <h2 className="text-xl font-bold break-words">{row.fullName}</h2>
              <p className="mt-1 truncate text-sm text-[var(--color-text-muted)]">
                {row.courseTitle}
              </p>
            </div>
            <Button size="icon" variant="ghost" onClick={onClose} aria-label="Закрыть">
              <X />
            </Button>
          </header>
          <div className="flex-1 space-y-4 overflow-y-auto p-4">
            <div className="flex items-center gap-3 rounded-xl bg-[var(--color-surface-muted)] p-3">
              <ProfileAvatar row={row} canReadIdentity={permissions.canReadIdentity} />
              <dl className="min-w-0 space-y-2 text-sm">
                <div>
                  <dt className="text-xs text-[var(--color-text-subtle)]">Должность</dt>
                  <dd className="break-words">{row.job || 'Не указана'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-subtle)]">Компания</dt>
                  <dd className="break-words">{row.organization || 'Не указана'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-[var(--color-text-subtle)]">Контакт</dt>
                  <dd className="break-all">
                    {history.state === 'loading' ? (
                      'Загружается…'
                    ) : history.state === 'ready' && history.email ? (
                      <a className="underline underline-offset-4" href={`mailto:${history.email}`}>
                        {history.email}
                      </a>
                    ) : (
                      'Не указан'
                    )}
                  </dd>
                </div>
              </dl>
            </div>

            <dl className="grid gap-3 rounded-2xl border p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-[var(--color-text-subtle)]">Лучший результат</dt>
                <dd className="mt-1 text-lg font-black tabular-nums">
                  {row.score}/{row.total}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--color-text-subtle)]">Проходной балл</dt>
                <dd className="mt-1 font-bold tabular-nums">{row.passScore}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-[var(--color-text-subtle)]">Дата результата</dt>
                <dd className="mt-1">{formatDateTime(row.completedAt)}</dd>
              </div>
            </dl>

            <section className="space-y-3">
              <h3 className="sr-only">Состояние</h3>
              <div className="flex flex-wrap gap-2">
                <AttestationWorkflowBadge row={row} />
                {row.scoreImproved ? <Badge variant="warning">Результат улучшен</Badge> : null}
              </div>
            </section>

            {row.certificateNumber ? (
              <section className="space-y-3 rounded-2xl bg-[var(--color-primary-soft)] p-4">
                <h3 className="text-base font-bold">Сертификат</h3>
                <p className="font-mono text-sm">{row.certificateNumber}</p>
                {row.certificateScore !== null && row.certificateScore !== row.score ? (
                  <p className="text-sm">
                    В сертификате: {row.certificateScore}/{row.total}
                  </p>
                ) : null}
                {row.certificateId && row.certificateState === 'issued' ? (
                  <CertificateDownloadButton certificateId={row.certificateId} variant="outline" />
                ) : null}
              </section>
            ) : null}

            {permissions.canReadCertificate && !row.courseDeleted ? (
              <details className="rounded-2xl border p-4">
                <summary className="min-h-11 cursor-pointer content-center font-bold">
                  История сертификатов
                </summary>
                <div className="mt-3">
                  {history.state === 'loading' ? (
                    <p className="text-sm text-[var(--color-text-muted)]">Загружаем документы…</p>
                  ) : history.state === 'failed' ? (
                    <p role="alert" className="text-sm text-[var(--color-danger)]">
                      История временно недоступна.
                    </p>
                  ) : history.state === 'ready' && history.items.length > 0 ? (
                    <ol className="space-y-2">
                      {history.items.map((certificate) => (
                        <li key={certificate.id} className="rounded-xl border p-3 text-sm">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <p className="font-mono font-bold">{certificate.certificateNumber}</p>
                              <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                                Выдан {formatDateTime(certificate.issuedAt)} · {certificate.score}/
                                {certificate.total}
                              </p>
                            </div>
                            <Badge variant={certificate.revokedAt ? 'danger' : 'success'}>
                              {certificate.revokedAt ? 'Отозван' : 'Действует'}
                            </Badge>
                          </div>
                          {certificate.revokedAt ? (
                            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
                              Отозван {formatDateTime(certificate.revokedAt)}
                              {certificate.revokeReason ? ` · ${certificate.revokeReason}` : ''}
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-[var(--color-text-muted)]">Документов пока нет.</p>
                  )}
                </div>
              </details>
            ) : null}

            {permissions.canManageIdentity && !row.courseDeleted ? (
              <AttestationIdentityForm
                key={`${row.userId}:${row.name}:${row.surname}:${row.job}:${row.organization}`}
                row={row}
                onSaved={onSaved}
              />
            ) : null}
            {permissions.canDeleteHistory ? (
              <LearningHistoryControl
                key={`learning-history:${row.userId}`}
                userId={row.userId}
                userLabel={row.fullName}
                onDeleted={onHistoryDeleted}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
