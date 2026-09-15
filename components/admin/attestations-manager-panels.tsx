'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Buildings } from '@phosphor-icons/react/dist/csr/Buildings';
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { Certificate } from '@phosphor-icons/react/dist/csr/Certificate';
import { CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { FloppyDisk } from '@phosphor-icons/react/dist/csr/FloppyDisk';
import { PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { WhatsappLogo } from '@phosphor-icons/react/dist/csr/WhatsappLogo';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type { AdminAttestationRow } from '@/lib/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { formatDateTime } from '@/lib/utils';
import { formatPhoneDisplay, phoneHref, whatsappChatHref } from '@/lib/site-contacts';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertificateDownloadButton } from '@/components/certificates/download-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LearningHistoryControl } from '@/components/admin/learning-history-control';
import { CourseAccessControl } from '@/components/admin/course-access-control';

export type AttestationPermissions = {
  canManageDocuments?: boolean;
  canReadUser: boolean;
  canReadIdentity: boolean;
  canReadCertificate: boolean;
  canManageIdentity: boolean;
  canIssue: boolean;
  canExport: boolean;
  canDeleteHistory: boolean;
  canDeleteUser: boolean;
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
  | { kind: 'confirm-issue' }
  | { kind: 'bulk-update'; field: 'organization' }
  | { kind: 'issue' }
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
  // The stored value is still `revoked`, but revocation is no longer a product
  // concept: for an operator this state simply means "check the data again".
  revoked: 'Нужна повторная проверка',
};

const certificateLabels: Record<AdminAttestationRow['certificateState'], string> = {
  not_eligible: 'Не сдан',
  pending_identity: 'Ожидает проверки',
  ready: 'Готов к выдаче',
  issued: 'Выдан',
  revoked: 'Нужно выдать заново',
};

export const attestationFieldLabels = {
  name: 'Имя',
  surname: 'Фамилия',
  job: 'Должность',
  organization: 'Компания',
} as const;

/**
 * Mirrors the profile column widths. It is duplicated here rather than imported
 * from `lib/profile/fields`, because that module pulls in the phone
 * library and this panel is measured against a bundle budget.
 */
export const attestationFieldMaxLengths = {
  name: 80,
  surname: 80,
  job: 160,
  organization: 160,
} as const satisfies Record<keyof typeof attestationFieldLabels, number>;

export type AttestationIdentityFields = {
  name: string;
  surname: string;
  job: string;
  organization: string;
};

function identityVariant(state: AdminAttestationRow['identityState']): BadgeProps['variant'] {
  if (state === 'verified') return 'success';
  if (state === 'changed' || state === 'revoked') return 'warning';
  return 'outline';
}

function certificateVariant(state: AdminAttestationRow['certificateState']): BadgeProps['variant'] {
  if (state === 'issued') return 'success';
  if (state === 'ready') return 'primary';
  if (state === 'not_eligible') return 'danger';
  // `revoked` now reads as "reissue needed", which is an action, not a failure.
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

export function AttestationWorkflowBadge({
  row,
  className,
}: {
  row: AdminAttestationRow;
  /** Size adjustments from the caller: the list row makes it smaller on a phone. */
  className?: string;
}) {
  const status = workflowStatus(row);
  return (
    // A status never breaks onto a second line: a two-line pill in a table
    // column reads as a rendering fault. A label that does not fit is cut
    // with an ellipsis and shown whole on hover.
    <span className="flex max-w-full min-w-0 flex-wrap gap-1">
      <Badge
        variant={status.variant}
        className={`max-w-full ${className ?? ''}`}
        title={status.label}
      >
        <span className="min-w-0 truncate">{status.label}</span>
      </Badge>
      {row.courseDeleted ? (
        <Badge variant="outline" className={`max-w-full ${className ?? ''}`}>
          <span className="min-w-0 truncate">Курс удалён</span>
        </Badge>
      ) : null}
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
  const photo = row.avatarAvailable && canReadIdentity;
  const avatar = (
    <Avatar className="size-20 rounded-[var(--radius-group)]">
      {photo ? (
        <AvatarImage
          src={src}
          alt={`Фото: ${row.fullName}`}
          className="rounded-[var(--radius-group)] object-cover"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <AvatarFallback className="rounded-[var(--radius-group)] text-xl">
        {initials(row)}
      </AvatarFallback>
    </Avatar>
  );
  // The photo is what the name is checked against, so a tap opens it full size.
  return photo ? (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      title="Открыть фото"
      className="shrink-0 rounded-[var(--radius-group)]"
    >
      {avatar}
    </a>
  ) : (
    avatar
  );
}

/**
 * The single most useful action for a row, derived from its state.
 *
 * Operators had to work out which of "confirm", "issue" and "fix data" applied
 * to a given person by reading two badges. The row, the card and the bulk panel
 * now all agree on one answer.
 */
function nextAttestationStep(
  row: AdminAttestationRow,
  permissions: AttestationPermissions,
): { label: string; action: AttestationPendingAction } | null {
  if (row.courseDeleted) return null;
  if (row.certificateState === 'not_eligible') return null;
  if (row.identityState !== 'verified' && permissions.canManageIdentity) {
    if (
      permissions.canIssue &&
      row.certificateState === 'pending_identity' &&
      Boolean(row.attestationId)
    ) {
      return { label: 'Подтвердить и выдать', action: { kind: 'confirm-issue' } };
    }
    return { label: 'Подтвердить данные', action: { kind: 'confirm' } };
  }
  if (
    permissions.canIssue &&
    (row.certificateState === 'ready' || row.certificateState === 'revoked')
  ) {
    return {
      label: row.certificateState === 'revoked' ? 'Выдать сертификат заново' : 'Выдать сертификат',
      action: { kind: 'issue' },
    };
  }
  return null;
}

export function AttestationRowActions({
  row,
  permissions,
  openAction,
}: {
  row: AdminAttestationRow;
  permissions: AttestationPermissions;
  openAction: (action: AttestationPendingAction) => void;
}) {
  const nextStep = nextAttestationStep(row, permissions);
  // "Open the card" and "fix the name" were two thirds of this menu, and a
  // click anywhere on the row already does both. What is left is the step the
  // row is waiting for and the irreversible one; with neither, no button.
  if (!nextStep && !permissions.canDeleteUser) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="size-10 @min-[760px]:size-11"
          aria-label={`Действия: ${row.fullName}`}
        >
          <DotsThree weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {nextStep ? (
          <DropdownMenuItem onSelect={() => openAction(nextStep.action)}>
            {nextStep.label}
          </DropdownMenuItem>
        ) : null}
        {permissions.canDeleteUser ? (
          <>
            {nextStep ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              className="text-[var(--color-danger)]"
              onSelect={() => openAction({ kind: 'bulk-delete' })}
            >
              Удалить сотрудника и все его данные
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Bulk actions: one combined primary action, an export, and the rest behind
 * «Ещё». Selection is cleared from the banner above the table.
 */
export function AttestationBulkActionButtons({
  summary,
  permissions,
  busy,
  onAction,
  compact = false,
}: {
  summary: AttestationSelectionSummary;
  permissions: AttestationPermissions;
  busy: boolean;
  onAction: (action: AttestationPendingAction) => void;
  compact?: boolean;
}) {
  const primary: Array<{
    key: string;
    label: string;
    icon: React.ReactNode;
    disabled: boolean;
    variant: 'primary' | 'outline';
    action: AttestationPendingAction;
  }> = [];

  if (permissions.canManageIdentity && permissions.canIssue) {
    primary.push({
      key: 'confirm-issue',
      label: 'Подтвердить и выдать',
      icon: <CheckCircle />,
      disabled: summary.total === 0,
      variant: 'primary',
      action: { kind: 'confirm-issue' },
    });
  } else if (permissions.canManageIdentity) {
    primary.push({
      key: 'confirm',
      label: 'Подтвердить данные',
      icon: <CheckCircle />,
      disabled: summary.pendingIdentity === 0,
      variant: 'primary',
      action: { kind: 'confirm' },
    });
  } else if (permissions.canIssue) {
    primary.push({
      key: 'issue',
      label: 'Выдать сертификаты',
      icon: <Certificate />,
      disabled: summary.readyToIssue === 0,
      variant: 'primary',
      action: { kind: 'issue' },
    });
  }
  if (permissions.canExport) {
    primary.push({
      key: 'export',
      label: 'Скачать пакет документов',
      icon: <DownloadSimple />,
      disabled: busy,
      variant: 'outline',
      action: { kind: 'export' },
    });
  }

  return (
    <div className={compact ? 'grid gap-2' : 'flex flex-wrap items-center gap-2'}>
      {primary.map((item) => (
        <Button
          key={item.key}
          size={compact ? 'md' : 'sm'}
          variant={item.variant}
          disabled={item.disabled}
          onClick={() => onAction(item.action)}
          className={compact ? 'w-full' : undefined}
        >
          {item.icon} {item.label}
        </Button>
      ))}

      {permissions.canManageIdentity || permissions.canDeleteUser ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size={compact ? 'md' : 'sm'}
              variant="ghost"
              className={compact ? 'w-full justify-start' : undefined}
            >
              <DotsThree size={20} weight="bold" /> Ещё
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            {permissions.canManageIdentity ? (
              <DropdownMenuItem
                disabled={summary.people === 0}
                onSelect={() => onAction({ kind: 'bulk-update', field: 'organization' })}
              >
                <Buildings /> Переименовать компанию у {summary.people} чел.
              </DropdownMenuItem>
            ) : null}
            {permissions.canDeleteUser ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={summary.people === 0}
                  className="text-[var(--color-danger)]"
                  onSelect={() => onAction({ kind: 'bulk-delete' })}
                >
                  <Trash /> Удалить {summary.people} чел. со всеми данными
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

function AttestationIdentityForm({
  row,
  onSaved,
  onCancel,
}: {
  row: AdminAttestationRow;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState<AttestationIdentityFields>({
    name: row.name,
    surname: row.surname,
    job: row.job,
    organization: row.organization,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const update =
    (field: keyof AttestationIdentityFields) => (event: React.ChangeEvent<HTMLInputElement>) => {
      setError('');
      setFields((current) => ({ ...current, [field]: event.target.value }));
    };

  const dirty = (Object.keys(fields) as Array<keyof AttestationIdentityFields>).some(
    (field) => fields[field].trim() !== row[field],
  );

  const save = async () => {
    if (busy) return;
    const normalized = {
      name: fields.name.trim(),
      surname: fields.surname.trim(),
      job: fields.job.trim(),
      organization: fields.organization.trim(),
    };
    if (Object.values(normalized).some((value) => value.length < 2)) {
      setError('Заполните все четыре поля — минимум по два символа.');
      return;
    }

    setBusy(true);
    setError('');
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
        setError(clientRequestMessage(result.error, 'Не удалось сохранить данные.'));
        return;
      }
      if (!payload?.status) {
        setError('Сервер вернул неполный ответ. Обновите страницу и проверьте данные.');
        return;
      }
      onSaved(row, normalized);
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Не удалось сохранить данные.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {(Object.keys(attestationFieldLabels) as Array<keyof AttestationIdentityFields>).map(
          (field, index) => (
            <div key={field}>
              <Label className="sr-only" htmlFor={`attestation-${field}-${row.userId}`}>
                {attestationFieldLabels[field]}
              </Label>
              <Input
                id={`attestation-${field}-${row.userId}`}
                placeholder={attestationFieldLabels[field]}
                value={fields[field]}
                maxLength={attestationFieldMaxLengths[field]}
                onChange={update(field)}
                autoComplete="off"
                autoFocus={index === 0}
                disabled={busy}
              />
            </div>
          ),
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="min-w-0 flex-1 sm:flex-none"
          disabled={busy || !dirty}
          aria-busy={busy || undefined}
        >
          <FloppyDisk /> {busy ? 'Сохраняем…' : 'Сохранить данные'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

type DetailProps = {
  permissions: AttestationPermissions;
  onClose: () => void;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
  onHistoryDeleted: () => void;
  onAction: (row: AdminAttestationRow, action: AttestationPendingAction) => void;
};

function AttestationDetailContent({
  row,
  titleId,
  permissions,
  onClose,
  onSaved,
  onHistoryDeleted,
  onAction,
}: DetailProps & { row: AdminAttestationRow; titleId: string }) {
  // One card, three states: reading it, correcting the person's data in place,
  // and confirming the deletion of their learning history where the delete
  // link was pressed. A new person always opens in the first.
  const [mode, setMode] = useState<'view' | 'edit' | 'delete-history'>('view');
  const [contact, setContact] = useState<{
    state: 'idle' | 'loading' | 'failed' | 'ready';
    email: string | null;
    phoneE164: string | null;
  }>({ state: 'idle', email: null, phoneE164: null });
  const [history, setHistory] = useState<{
    state: 'idle' | 'loading' | 'failed' | 'ready';
    items: CertificateHistoryItem[];
  }>({ state: 'idle', items: [] });
  const bodyRef = useRef<HTMLDivElement>(null);
  const dangerRef = useRef<HTMLDivElement>(null);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const deleteHistoryRef = useRef<HTMLButtonElement>(null);
  const previousModeRef = useRef<typeof mode>('view');
  const { testId, testVersion, courseDeleted } = row;
  const {
    canReadUser,
    canReadIdentity,
    canReadCertificate,
    canManageIdentity,
    canDeleteHistory,
    canDeleteUser,
  } = permissions;

  // The address and the phone are asked for the moment the card opens: the
  // administrator's first question about a person is how to reach them.
  useEffect(() => {
    if (!canReadUser) return;
    const controller = new AbortController();
    setContact({ state: 'loading', email: null, phoneE164: null });
    void (async () => {
      const result = await clientRequest(
        `/api/admin/attestations/contact/${row.userId}`,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const payload = await readClientResponseJson<{
        email?: string | null;
        phoneE164?: string | null;
      }>(result.response);
      if (!result.ok || !payload) {
        setContact({ state: 'failed', email: null, phoneE164: null });
        return;
      }
      setContact({
        state: 'ready',
        email: payload.email ?? null,
        phoneE164: payload.phoneE164 ?? null,
      });
    })().catch(() => {
      if (!controller.signal.aborted) {
        setContact({ state: 'failed', email: null, phoneE164: null });
      }
    });
    return () => controller.abort();
  }, [canReadUser, row.userId]);

  useEffect(() => {
    if (courseDeleted || !testId || testVersion === null || !canReadCertificate || !canReadUser) {
      return;
    }
    const controller = new AbortController();
    setHistory({ state: 'loading', items: [] });
    void (async () => {
      const params = new URLSearchParams({ testId, testVersion: String(testVersion) });
      const result = await clientRequest(
        `/api/admin/attestations/history/${row.userId}?${params}`,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const payload = await readClientResponseJson<{
        items?: CertificateHistoryItem[];
      }>(result.response);
      if (!result.ok || !payload?.items) {
        setHistory({ state: 'failed', items: [] });
        return;
      }
      setHistory({ state: 'ready', items: payload.items });
    })().catch(() => {
      if (!controller.signal.aborted) setHistory({ state: 'failed', items: [] });
    });
    return () => controller.abort();
  }, [canReadCertificate, canReadUser, courseDeleted, testId, testVersion, row.userId]);

  // The eye follows the change: editing starts at the top of the card, the
  // deletion confirmation opens where its link was. Coming back, focus returns
  // to the control that left the card view, because the form or confirmation
  // that held it is gone and focus stranded on <body> leaves the keyboard
  // nowhere.
  useEffect(() => {
    const previous = previousModeRef.current;
    previousModeRef.current = mode;
    if (mode === 'edit') bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    if (mode === 'delete-history') {
      dangerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    if (mode === 'view' && previous === 'edit') pencilRef.current?.focus();
    if (mode === 'view' && previous === 'delete-history') deleteHistoryRef.current?.focus();
  }, [mode]);

  const nextStep = nextAttestationStep(row, permissions);
  const canEdit = canManageIdentity && !courseDeleted;

  return (
    <div className="flex h-full max-h-[inherit] flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-[var(--color-border)] pt-[var(--safe-area-top)] pr-2 pl-4 sm:pt-0 sm:pr-3 sm:pl-5">
        <h2
          id={titleId}
          className="min-w-0 flex-1 truncate py-2 text-base font-bold sm:text-lg"
          title={row.fullName}
        >
          {row.fullName}
        </h2>
        {canEdit ? (
          <Button
            ref={pencilRef}
            type="button"
            size="icon"
            variant="ghost"
            aria-pressed={mode === 'edit'}
            aria-label="Исправить данные"
            title="Исправить данные"
            className={
              mode === 'edit'
                ? 'bg-[var(--color-surface-muted)] text-[var(--color-primary)]'
                : undefined
            }
            onClick={() => setMode((current) => (current === 'edit' ? 'view' : 'edit'))}
          >
            <PencilSimple />
          </Button>
        ) : null}
        <Button
          type="button"
          size="icon"
          variant="ghost"
          onClick={onClose}
          aria-label="Закрыть"
          data-dialog-initial-focus
        >
          <X />
        </Button>
      </header>

      <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="grid grid-cols-1 gap-6 p-4 sm:p-5 lg:grid-cols-2 lg:items-start lg:gap-8">
          {/* The person: who it is, how to reach them, what they may open. */}
          <div className="space-y-5">
            {mode === 'edit' ? (
              <AttestationIdentityForm
                row={row}
                onCancel={() => setMode('view')}
                onSaved={(savedRow, fields) => {
                  setMode('view');
                  onSaved(savedRow, fields);
                }}
              />
            ) : (
              <div className="flex items-start gap-4">
                <ProfileAvatar row={row} canReadIdentity={canReadIdentity} />
                <div className="min-w-0 flex-1 space-y-0.5 pt-1">
                  <p className="font-semibold break-words">{row.job || '—'}</p>
                  <p className="text-sm break-words text-[var(--color-text-muted)]">
                    {row.organization || '—'}
                  </p>
                  {contact.state === 'loading' ? (
                    <span
                      aria-hidden="true"
                      className="mt-2 block h-4 w-40 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]"
                    />
                  ) : contact.email ? (
                    <a
                      href={`mailto:${contact.email}`}
                      title={contact.email}
                      className="block truncate pt-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
                    >
                      {contact.email}
                    </a>
                  ) : null}
                </div>
              </div>
            )}

            {contact.phoneE164 ? (
              <div className="flex gap-2">
                <Button asChild variant="outline" className="min-w-0 flex-1 tabular-nums">
                  <a href={phoneHref(contact.phoneE164)}>{formatPhoneDisplay(contact.phoneE164)}</a>
                </Button>
                {/* A new tab, so the card stays open behind the chat.
                    `noopener` keeps that tab from reaching back here. */}
                <Button asChild variant="outline" size="icon">
                  <a
                    href={whatsappChatHref(contact.phoneE164)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Написать в WhatsApp"
                    title="Написать в WhatsApp"
                  >
                    <WhatsappLogo aria-hidden="true" />
                  </a>
                </Button>
              </div>
            ) : contact.state === 'failed' ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                Контакты не загрузились.
              </p>
            ) : null}

            {canReadIdentity || canManageIdentity ? (
              <CourseAccessControl
                key={`course-access:${row.userId}`}
                userId={row.userId}
                canManage={permissions.canManageIdentity}
              />
            ) : null}
          </div>

          {/* The work: this course's result and its certificate. */}
          <div className="space-y-4">
            <section
              aria-labelledby={`${titleId}-course`}
              className="space-y-3 rounded-[var(--radius-group)] bg-[var(--color-surface-muted)] p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 id={`${titleId}-course`} className="min-w-0 font-bold break-words">
                  {row.courseTitle}
                </h3>
                <AttestationWorkflowBadge row={row} />
              </div>
              <p className="text-2xl leading-none font-black tabular-nums">
                {row.score}/{row.total}
              </p>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-[var(--color-text-muted)]">
                <time dateTime={row.completedAt} className="tabular-nums">
                  {formatDateTime(row.completedAt)}
                </time>
                {row.scoreImproved ? <Badge variant="warning">Результат улучшен</Badge> : null}
              </div>
              {row.certificateNumber ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--color-border)] pt-3">
                  <Certificate
                    size={22}
                    aria-hidden="true"
                    className="shrink-0 text-[var(--color-primary)]"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-semibold">
                      {row.certificateNumber}
                    </p>
                    {row.certificateScore !== null && row.certificateScore !== row.score ? (
                      <p className="text-xs text-[var(--color-text-muted)] tabular-nums">
                        В сертификате: {row.certificateScore}/{row.total}
                      </p>
                    ) : null}
                  </div>
                  {row.certificateId && row.certificateState === 'issued' ? (
                    <CertificateDownloadButton
                      certificateId={row.certificateId}
                      variant="outline"
                    />
                  ) : null}
                </div>
              ) : null}
            </section>

            {permissions.canManageDocuments && row.organization && !courseDeleted ? <a className="inline-block min-h-11 text-sm underline" href={'/admin/settings/certificate?' + new URLSearchParams({ organization: row.organization, course: row.testId ?? '', user: row.userId, tab: 'certificate' })}>Открыть корочку в редакторе</a> : null}
            {canReadCertificate && !courseDeleted ? (
              <details className="group rounded-[var(--radius-group)] border border-[var(--color-border)]">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 font-semibold [&::-webkit-details-marker]:hidden">
                  <span>
                    История сертификатов
                    {history.state === 'ready' ? (
                      <span className="ml-1.5 text-[var(--color-text-muted)] tabular-nums">
                        {history.items.length}
                      </span>
                    ) : null}
                  </span>
                  <CaretDown
                    size={16}
                    aria-hidden="true"
                    className="shrink-0 transition-transform group-open:rotate-180"
                  />
                </summary>
                <div className="border-t border-[var(--color-border)] px-4 py-1">
                  {history.state === 'failed' ? (
                    <p role="alert" className="py-2.5 text-sm text-[var(--color-danger)]">
                      История не загрузилась.
                    </p>
                  ) : history.state !== 'ready' ? (
                    <p className="py-2.5 text-sm text-[var(--color-text-muted)]">Загружаем…</p>
                  ) : history.items.length > 0 ? (
                    <ol className="divide-y divide-[var(--color-border)]">
                      {history.items.map((certificate) => (
                        <li
                          key={certificate.id}
                          className="flex items-center justify-between gap-3 py-2.5 text-sm"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-mono font-semibold">
                              {certificate.certificateNumber}
                            </p>
                            <p className="text-xs text-[var(--color-text-muted)] tabular-nums">
                              {formatDateTime(certificate.issuedAt)} · {certificate.score}/
                              {certificate.total}
                              {certificate.revokedAt
                                ? ` · отозван ${formatDateTime(certificate.revokedAt)}`
                                : ''}
                            </p>
                            {certificate.revokedAt && certificate.revokeReason ? (
                              <p className="text-xs break-words text-[var(--color-text-muted)]">
                                {certificate.revokeReason}
                              </p>
                            ) : null}
                          </div>
                          <Badge
                            variant={certificate.revokedAt ? 'danger' : 'success'}
                            className="shrink-0"
                          >
                            {certificate.revokedAt ? 'Отозван' : 'Действует'}
                          </Badge>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="py-2.5 text-sm text-[var(--color-text-muted)]">Документов нет.</p>
                  )}
                </div>
              </details>
            ) : null}

            {mode === 'delete-history' ? (
              <div ref={dangerRef}>
                <LearningHistoryControl
                  variant="confirm"
                  userId={row.userId}
                  userLabel={row.fullName}
                  onCancel={() => setMode('view')}
                  onDeleted={onHistoryDeleted}
                />
              </div>
            ) : canDeleteHistory || canDeleteUser ? (
              <div className="flex flex-wrap gap-x-6 border-t border-[var(--color-border)] pt-1">
                {canDeleteHistory ? (
                  <button
                    ref={deleteHistoryRef}
                    type="button"
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-danger)] hover:underline"
                    onClick={() => setMode('delete-history')}
                  >
                    <Trash size={18} aria-hidden="true" />
                    Удалить учебную историю
                  </button>
                ) : null}
                {canDeleteUser ? (
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-[var(--color-danger)] hover:underline"
                    onClick={() => onAction(row, { kind: 'bulk-delete' })}
                  >
                    <Trash size={18} aria-hidden="true" />
                    Удалить сотрудника
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {nextStep && mode === 'view' ? (
        <footer className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 pb-[calc(0.75rem+var(--safe-area-bottom))] sm:flex sm:justify-end sm:px-5 sm:pb-3">
          <Button
            type="button"
            className="w-full sm:w-auto"
            onClick={() => onAction(row, nextStep.action)}
          >
            {nextStep.label}
          </Button>
        </footer>
      ) : null}
    </div>
  );
}

export function AttestationDetailDrawer({
  row,
  permissions,
  onClose,
  onSaved,
  onHistoryDeleted,
  onAction,
}: DetailProps & { row: AdminAttestationRow | null }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (row && dialog && !dialog.open) {
      dialog.showModal();
      // Focus lands on "close", not on the first button in the header, which
      // would put the card into edit mode on an accidental Enter.
      dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')?.focus();
    }
    if (!row && dialog?.open) dialog.close();
  }, [row]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={row ? titleId : undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={() => {
        if (row) onClose();
      }}
      // A full-screen sheet on a phone, sized by the window itself. The admin
      // shell caps every dialog at 92dvh (globals.css), and that rule outranks
      // a plain utility, so the sheet came out short and the navigation dock
      // showed under it; its own limits are therefore marked important. From
      // the tablet up it is a centred window, and on a laptop the person and
      // the work stand in two columns.
      className="m-0 size-full max-h-none! max-w-none overflow-hidden border-0 bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/50 sm:m-auto sm:h-fit sm:max-h-[calc(100dvh-3rem)]! sm:w-[min(40rem,calc(100vw-3rem))] sm:rounded-[var(--radius-group)] sm:border sm:border-[var(--color-border)] lg:w-[min(60rem,calc(100vw-4rem))]"
    >
      {row ? (
        <AttestationDetailContent
          key={row.recordId}
          row={row}
          titleId={titleId}
          permissions={permissions}
          onClose={onClose}
          onSaved={onSaved}
          onHistoryDeleted={onHistoryDeleted}
          onAction={onAction}
        />
      ) : null}
    </dialog>
  );
}
