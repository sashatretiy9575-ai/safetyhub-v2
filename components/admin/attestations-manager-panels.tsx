'use client';

import { useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
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
import { Phone } from '@phosphor-icons/react/dist/csr/Phone';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type { AdminAttestationRow } from '@/lib/admin/types';
import { attestationNeedsIssuance } from '@/lib/admin/attestation-issuance';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { formatDateTime } from '@/lib/utils';
import {
  formatPhoneDisplay,
  isDialablePhone,
  phoneHref,
  whatsappChatHref,
} from '@/lib/site-contacts';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertificateDownloadButton } from '@/components/certificates/download-button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
const LearningHistoryControl = dynamic(
  () =>
    import('@/components/admin/learning-history-control').then(
      (module) => module.LearningHistoryControl,
    ),
  { loading: () => <p role="status">Загружаем действия…</p> },
);
const CourseAccessControl = dynamic(
  () =>
    import('@/components/admin/course-access-control').then((module) => module.CourseAccessControl),
  { loading: () => <p role="status">Загружаем допуски…</p> },
);

/**
 * Fetches the card's lazy chunk ahead of the first click. The list asks for it
 * once the browser is idle, so opening a person no longer starts with a
 * download; the same specifier as above resolves to the same chunk.
 */
export const preloadAttestationCard = () => void import('@/components/admin/course-access-control');

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

/** What the operator has typed and not saved; `education` is null until it loads. */
export type AttestationIdentityDraft = {
  fields: AttestationIdentityFields;
  education: string | null;
};

/** A refused issuance that the person's own data can fix, opened on the fields at fault. */
export type AttestationCardIssue = {
  fields: Array<'organization' | 'job' | 'education'>;
  message: string;
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
        <span className="min-w-0 [overflow-wrap:anywhere] whitespace-normal">{status.label}</span>
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
  const [photoState, setPhotoState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // A photo that did not arrive counts as absent: the initials stay and the box
  // stops pulsing, so a missing file never reads as an endless loader.
  const photo = row.avatarAvailable && canReadIdentity && photoState !== 'failed';
  const avatar = (
    // The box has its final size before anything loads and the initials are
    // always in it, so the card never waits for the photo and nothing moves
    // when it arrives.
    <span
      data-profile-avatar
      className={`relative grid size-20 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-group)] bg-[var(--color-primary-soft)] text-xl font-medium text-[var(--color-primary-hover)] ${
        photo && photoState === 'loading' ? 'animate-pulse' : ''
      }`}
    >
      <span aria-hidden="true">{initials(row)}</span>
      {photo ? (
        // A private image behind the session; next/image has nothing to optimise.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={`Фото: ${row.fullName}`}
          width={80}
          height={80}
          decoding="async"
          fetchPriority="high"
          onLoad={() => setPhotoState('ready')}
          onError={() => setPhotoState('failed')}
          className={`absolute inset-0 size-full object-cover transition-opacity ${
            photoState === 'ready' ? '' : 'opacity-0'
          }`}
        />
      ) : null}
    </span>
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
  if (permissions.canIssue && attestationNeedsIssuance(row)) {
    return {
      label: row.scoreImproved
        ? 'Выдать по улучшенному результату'
        : row.certificateState === 'revoked'
          ? 'Выдать сертификат заново'
          : 'Выдать сертификат',
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
  // Deletion belongs to the selection panel and the bottom of the person card.
  if (!nextStep) return null;
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
      <DropdownMenuContent
        align="end"
        className="w-64 max-w-[calc(100vw-1rem)] [overflow-wrap:anywhere]"
      >
        {nextStep ? (
          <DropdownMenuItem onSelect={() => openAction(nextStep.action)}>
            {nextStep.label}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Direct selection actions, with destructive work separated below. */
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
      // Nobody to confirm and nothing to issue: the button would only open a
      // dialog that ends in "Пропущено: N".
      disabled: summary.pendingIdentity === 0 && summary.readyToIssue === 0,
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
      // Without a live certificate in the selection the dialog read "0 из N".
      disabled: summary.exportable === 0,
      variant: 'outline',
      action: { kind: 'export' },
    });
  }

  return (
    <div className="min-w-0 space-y-3">
      <div
        className={
          compact
            ? 'grid min-w-0 gap-2'
            : 'grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-2'
        }
      >
        {primary.map((item) => (
          <Button
            key={item.key}
            size={compact ? 'md' : 'sm'}
            variant={item.variant}
            disabled={busy || item.disabled}
            onClick={() => onAction(item.action)}
            className="h-auto min-h-12 w-full min-w-0 px-3 py-3 [overflow-wrap:anywhere] whitespace-normal"
          >
            {item.icon} {item.label}
          </Button>
        ))}

        {permissions.canManageIdentity ? (
          <Button
            variant="outline"
            disabled={busy || summary.people === 0}
            className="h-auto min-h-12 w-full min-w-0 px-3 py-3 [overflow-wrap:anywhere] whitespace-normal"
            onClick={() => onAction({ kind: 'bulk-update', field: 'organization' })}
          >
            <Buildings /> Переименовать компанию
          </Button>
        ) : null}
      </div>
      {permissions.canDeleteUser ? (
        <div className="border-t border-[var(--color-border)] pt-3">
          <Button
            variant="outline"
            disabled={busy || summary.people === 0}
            className="h-auto min-h-11 max-w-full px-3 py-2 [overflow-wrap:anywhere] whitespace-normal text-[var(--color-danger)]"
            onClick={() => onAction({ kind: 'bulk-delete' })}
          >
            <Trash /> Удалить сотрудников ({summary.people})
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const EDUCATION_REQUIRED_MESSAGE = 'Заполните образование перед новой выдачей документа.';
const IDENTITY_CHANGED_MESSAGE =
  'Данные сотрудника не сохранены: их уже изменил другой администратор.';

function identitySaveFailure(error: unknown, code?: string) {
  return `Данные сотрудника не сохранены. ${clientRequestMessage(
    error,
    code ? `Код: ${code}.` : 'Обновите страницу и повторите.',
  )}`;
}

function AttestationIdentityForm({
  row,
  issue,
  getDraft,
  onDraft,
  onSaved,
  onStale,
  onCancel,
}: {
  row: AdminAttestationRow;
  issue: AttestationCardIssue | undefined;
  /** Asked once, when the form opens: what was typed here and never saved. */
  getDraft: () => AttestationIdentityDraft | undefined;
  onDraft: (draft: AttestationIdentityDraft | null) => void;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
  /** Another administrator saved first: leave the form for the current data. */
  onStale: () => void;
  onCancel: () => void;
}) {
  const [draft] = useState(getDraft);
  const [fields, setFields] = useState<AttestationIdentityFields>(
    draft?.fields ?? {
      name: row.name,
      surname: row.surname,
      job: row.job,
      organization: row.organization,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(issue?.message ?? '');

  const [education, setEducation] = useState<string | null>(draft?.education ?? null);
  const [savedEducation, setSavedEducation] = useState('');
  const [educationRequired, setEducationRequired] = useState<boolean | null>(
    issue?.fields.includes('education') ? true : null,
  );
  const educationInputRef = useRef<HTMLInputElement>(null);
  // The identity version this form was opened on; the save names it, so a card
  // that another administrator has changed meanwhile is refused, not overwritten.
  const versionRef = useRef<number | undefined>(undefined);
  // The fields a refused issuance points at, for as long as its message stands.
  const issueFields: readonly string[] = issue && error === issue.message ? issue.fields : [];
  const educationLoaded = education !== null;
  const focusEducation = error === EDUCATION_REQUIRED_MESSAGE || issueFields[0] === 'education';
  useEffect(() => {
    // The field is disabled until its value loads, and a disabled field cannot
    // take focus, so this waits for the value as well as for the message.
    if (focusEducation && educationLoaded) educationInputRef.current?.focus();
  }, [focusEducation, educationRequired, educationLoaded]);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      // `clientRequest`, not `fetch`: a response that never comes now ends in
      // the message below instead of a field that stays disabled for good.
      const result = await clientRequest(
        `/api/admin/users/${row.userId}/identity${row.testId ? `?testId=${encodeURIComponent(row.testId)}` : ''}`,
        {},
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      const value = await readClientResponseJson<{
        education?: string | null;
        educationRequired?: boolean | null;
        version?: number;
      }>(result.response);
      if (controller.signal.aborted) return;
      if (!result.ok || !value) {
        setError('Не удалось загрузить образование. Закройте и повторите редактирование.');
        return;
      }
      versionRef.current = typeof value.version === 'number' ? value.version : undefined;
      // A draft typed on an earlier visit outlives the reload of the saved value.
      setEducation((current) => current ?? value.education ?? '');
      setSavedEducation(value.education ?? '');
      // Once a refusal has named the education, the field stays whatever this
      // answer says: it may have been sent before the refusal arrived.
      setEducationRequired((current) =>
        current === true
          ? true
          : typeof value.educationRequired === 'boolean'
            ? value.educationRequired
            : null,
      );
    })();
    return () => controller.abort();
  }, [row.userId, row.testId]);

  const differs = (next: AttestationIdentityFields) =>
    (Object.keys(next) as Array<keyof AttestationIdentityFields>).some(
      (field) => next[field].trim() !== row[field],
    );
  // Reported upward on every keystroke and kept in memory only, so closing the
  // card by accident does not cost the operator what they typed.
  const report = (nextFields: AttestationIdentityFields, nextEducation: string | null) =>
    onDraft(
      differs(nextFields) || (nextEducation !== null && nextEducation !== savedEducation)
        ? { fields: nextFields, education: nextEducation }
        : null,
    );

  const update =
    (field: keyof AttestationIdentityFields) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const next = { ...fields, [field]: event.target.value };
      setError('');
      setFields(next);
      report(next, education);
    };

  const dirty = differs(fields);

  const save = async () => {
    if (busy || education === null) return;
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
        body: JSON.stringify({
          action: 'verify',
          ...normalized,
          education,
          // Left out while the version is unknown; the server then skips the check.
          expectedVersion: versionRef.current,
        }),
      });
      const payload = await readClientResponseJson<{
        status?: string;
        error?: string;
        fields?: string[];
      }>(result.response);
      if (!result.ok) {
        const missingEducation =
          payload?.fields?.includes('education') ||
          payload?.error === 'DOCUMENT_REQUIRED_FIELDS:education';
        if (missingEducation) setEducationRequired(true);
        // The API validates the same four fields the form shows and answers a
        // bare 400, so that case names them; "не удалось сохранить" sent the
        // operator into a second identical attempt.
        setError(
          missingEducation
            ? EDUCATION_REQUIRED_MESSAGE
            : payload?.error === 'IDENTITY_CHANGED'
              ? IDENTITY_CHANGED_MESSAGE
              : result.error.status === 400
                ? 'Данные сотрудника не сохранены: сервер отклонил значения полей. Проверьте имя, фамилию, должность и компанию.'
                : identitySaveFailure(result.error, payload?.error),
        );
        return;
      }
      if (!payload?.status) {
        setError('Сервер вернул неполный ответ. Обновите страницу и проверьте данные.');
        return;
      }
      onDraft(null);
      onSaved(row, normalized);
    } catch (requestError) {
      setError(identitySaveFailure(requestError));
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
              <Label htmlFor={`attestation-${field}-${row.userId}`}>
                {attestationFieldLabels[field]}
              </Label>
              <Input
                id={`attestation-${field}-${row.userId}`}
                placeholder={attestationFieldLabels[field]}
                value={fields[field]}
                maxLength={attestationFieldMaxLengths[field]}
                onChange={update(field)}
                autoComplete="off"
                // A refused issuance opens the form on the field at fault.
                autoFocus={issueFields.length > 0 ? issueFields[0] === field : index === 0}
                invalid={issueFields.includes(field)}
                disabled={busy}
              />
            </div>
          ),
        )}
      </div>
      {educationRequired !== false ? (
        <div className="space-y-1">
          <Label htmlFor={`education-${row.userId}`}>
            Образование{educationRequired ? ' · для новой выдачи' : ''}
          </Label>
          <Input
            id={`education-${row.userId}`}
            ref={educationInputRef}
            aria-label="Образование"
            aria-describedby={`education-hint-${row.userId}`}
            value={education ?? ''}
            invalid={issueFields.includes('education')}
            disabled={busy || education === null}
            maxLength={200}
            onChange={(e) => {
              setError('');
              setEducation(e.target.value);
              report(fields, e.target.value);
            }}
          />
          <p id={`education-hint-${row.userId}`} className="text-sm text-[var(--color-text-muted)]">
            {educationRequired
              ? 'Заполните перед новой выдачей: образование печатается в этой форме.'
              : 'Обязательность зависит от формы нового документа.'}
          </p>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-danger)]"
        >
          {error}
          {error === IDENTITY_CHANGED_MESSAGE ? (
            // The way out of the conflict: drop what was typed over stale
            // values and read what the other administrator saved.
            <button
              type="button"
              className="min-h-11 font-semibold underline underline-offset-4"
              onClick={onStale}
            >
              Показать актуальные
            </button>
          ) : null}
        </p>
      ) : null}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-2">
        <Button
          type="submit"
          size="sm"
          className="min-w-0 flex-1 sm:flex-none"
          disabled={busy || education === null || (!dirty && education === savedEducation)}
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
  /** A refused issuance this person's data can fix: the card opens on those fields. */
  issue?: AttestationCardIssue;
  /** True while the action started from this card is on its way. */
  busy?: boolean;
  /** Why that action failed; it has no dialog of its own to say so. */
  error?: string;
  getDraft: (recordId: string) => AttestationIdentityDraft | undefined;
  onDraft: (recordId: string, draft: AttestationIdentityDraft | null) => void;
  onClose: () => void;
  onSaved: (row: AdminAttestationRow, fields: AttestationIdentityFields) => void;
  /** The card's data is older than the server's: the list has to be read again. */
  onStale: () => void;
  onHistoryDeleted: () => void;
  onAction: (row: AdminAttestationRow, action: AttestationPendingAction) => void;
};

function AttestationDetailContent({
  row,
  titleId,
  permissions,
  issue,
  busy = false,
  error = '',
  getDraft,
  onDraft,
  onClose,
  onSaved,
  onStale,
  onHistoryDeleted,
  onAction,
}: DetailProps & { row: AdminAttestationRow; titleId: string }) {
  const canEdit = permissions.canManageIdentity && !row.courseDeleted;
  // One card, three states: reading it, correcting the person's data in place,
  // and confirming the deletion of their learning history where the delete
  // link was pressed. A person opens in the first, unless there is something
  // of theirs to finish: an unsaved draft, or a refused issuance to fix.
  const [mode, setMode] = useState<'view' | 'edit' | 'delete-history'>(() =>
    canEdit && (issue || getDraft(row.recordId)) ? 'edit' : 'view',
  );
  const [contact, setContact] = useState<{
    state: 'idle' | 'loading' | 'failed' | 'ready';
    email: string | null;
    phoneE164: string | null;
  }>({ state: 'idle', email: null, phoneE164: null });
  const [history, setHistory] = useState<{
    state: 'idle' | 'loading' | 'failed' | 'ready';
    items: CertificateHistoryItem[];
  }>({ state: 'idle', items: [] });
  // Counters, as the course list uses: «Повторить» asks again by bumping one.
  const [contactAttempt, setContactAttempt] = useState(0);
  const [historyAttempt, setHistoryAttempt] = useState(0);
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
  }, [canReadUser, contactAttempt, row.userId]);

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
  }, [
    canReadCertificate,
    canReadUser,
    courseDeleted,
    historyAttempt,
    testId,
    testVersion,
    row.userId,
  ]);

  // The refusal arrives while the card is already open and being read.
  useEffect(() => {
    if (issue && canEdit) setMode('edit');
  }, [issue, canEdit]);

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
  // `idle` is the render before the request starts; it shows the same
  // placeholders as `loading`, so the first paint already has its final height.
  const contactPending = canReadUser && contact.state !== 'ready' && contact.state !== 'failed';

  return (
    <div className="flex h-full max-h-[inherit] min-w-0 flex-col [overflow-wrap:anywhere]">
      <header className="flex min-h-14 shrink-0 items-center gap-1 border-b border-[var(--color-border)] pt-[var(--safe-area-top)] pr-2 pl-4 sm:pt-0 sm:pr-3 sm:pl-5">
        <h2
          id={titleId}
          className="min-w-0 flex-1 py-2 text-base font-bold sm:text-lg"
          title={row.fullName}
        >
          {row.fullName}
        </h2>
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

      <div
        data-attestation-detail-body
        ref={bodyRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="grid grid-cols-1 gap-6 p-4 sm:p-5 lg:grid-cols-2 lg:items-start lg:gap-8">
          {/* The person: who it is, how to reach them, what they may open. */}
          <div className="min-w-0 space-y-5">
            {mode === 'edit' ? (
              <AttestationIdentityForm
                row={row}
                issue={issue}
                getDraft={() => getDraft(row.recordId)}
                onDraft={(draft) => onDraft(row.recordId, draft)}
                onCancel={() => {
                  // «Отмена» means the saved values: the draft goes with it.
                  onDraft(row.recordId, null);
                  setMode('view');
                }}
                onSaved={(savedRow, fields) => {
                  setMode('view');
                  onSaved(savedRow, fields);
                }}
                onStale={() => {
                  // The card goes back to reading, and the list is asked again:
                  // what the other administrator saved appears in its place.
                  onDraft(row.recordId, null);
                  setMode('view');
                  onStale();
                }}
              />
            ) : (
              // Wraps: at 240 px with enlarged text the photo leaves no room
              // beside it, and the lines go under it instead of into a strip
              // one letter wide.
              <div className="flex flex-wrap items-start gap-4">
                <ProfileAvatar row={row} canReadIdentity={canReadIdentity} />
                {/* The name is the card's heading, so it is not printed again. */}
                <div className="min-w-0 grow basis-24 space-y-0.5 pt-1">
                  <p className="font-semibold break-words">
                    {row.organization || 'Компания не указана'}
                  </p>
                  <p className="text-sm break-words text-[var(--color-text-muted)]">
                    Должность: {row.job || 'не указана'}
                  </p>
                  {contactPending || contact.state === 'failed' ? (
                    // The address line keeps its place while it loads, and
                    // after a failure too, so «Повторить» does not push the
                    // rows under it down when the address finally arrives.
                    <span
                      aria-hidden="true"
                      className={`mt-2 block h-4 w-40 max-w-full rounded ${
                        contactPending ? 'animate-pulse bg-[var(--color-surface-muted)]' : ''
                      }`}
                    />
                  ) : contact.email ? (
                    <a
                      href={`mailto:${contact.email}`}
                      title={contact.email}
                      className="block pt-1 text-sm break-all text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:underline"
                    >
                      {contact.email}
                    </a>
                  ) : null}
                </div>
              </div>
            )}

            {/* The form has its own «Отмена», so the way in is shown only while
                the card is being read. */}
            {canEdit && mode === 'view' ? (
              <Button
                ref={pencilRef}
                type="button"
                variant="secondary"
                className="h-auto min-h-11 w-full px-4 py-2 whitespace-normal sm:w-auto"
                onClick={() => setMode('edit')}
              >
                <PencilSimple /> Изменить данные
              </Button>
            ) : null}

            {/* One row of one height in every state, so nothing under it moves
                when the answer arrives. The number is printed once; the address
                is the link above, without a button of its own. */}
            {canReadUser ? (
              <div
                role="group"
                aria-label="Связаться"
                className="flex min-h-11 flex-wrap items-center gap-2"
              >
                {contact.state === 'failed' ? (
                  <p
                    role="alert"
                    className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-danger)]"
                  >
                    Контакты не загрузились.
                    <button
                      type="button"
                      className="min-h-11 font-semibold underline underline-offset-4"
                      onClick={() => setContactAttempt((value) => value + 1)}
                    >
                      Повторить
                    </button>
                  </p>
                ) : contactPending ? (
                  <>
                    <span
                      aria-hidden="true"
                      className="size-11 shrink-0 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)]"
                    />
                    <span
                      aria-hidden="true"
                      className="size-11 shrink-0 animate-pulse rounded-[var(--radius-control)] bg-[var(--color-surface-muted)]"
                    />
                    <span
                      aria-hidden="true"
                      className="h-6 w-32 max-w-full animate-pulse rounded bg-[var(--color-surface-muted)]"
                    />
                  </>
                ) : !contact.phoneE164 ? (
                  <p className="text-sm text-[var(--color-text-muted)]">Телефон не указан</p>
                ) : isDialablePhone(contact.phoneE164) ? (
                  <>
                    {/* A new tab, so the card stays open behind the chat.
                        `noopener` keeps that tab from reaching back here. */}
                    <Button asChild size="icon">
                      <a
                        href={whatsappChatHref(contact.phoneE164)}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={'Написать в WhatsApp: ' + formatPhoneDisplay(contact.phoneE164)}
                        title="WhatsApp"
                      >
                        <WhatsappLogo aria-hidden />
                      </a>
                    </Button>
                    <Button asChild size="icon" variant="outline">
                      <a
                        href={phoneHref(contact.phoneE164)}
                        aria-label={'Позвонить: ' + formatPhoneDisplay(contact.phoneE164)}
                        title="Позвонить"
                      >
                        <Phone aria-hidden />
                      </a>
                    </Button>
                    <span className="min-w-0 text-base font-semibold tabular-nums">
                      {formatPhoneDisplay(contact.phoneE164)}
                    </span>
                  </>
                ) : (
                  // Stored, but not a number a link could dial: shown as typed.
                  <span className="min-w-0 text-base font-semibold tabular-nums">
                    {contact.phoneE164}
                  </span>
                )}
              </div>
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
          <div className="min-w-0 space-y-4">
            <h3 className="font-bold">Обучение и документы</h3>
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

            {permissions.canManageDocuments && row.organization && !courseDeleted ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {(['certificate', 'protocol'] as const).map((tab) => (
                  <Button
                    key={tab}
                    asChild
                    variant="outline"
                    className="h-auto min-h-11 max-w-full min-w-0 px-3 text-center [overflow-wrap:anywhere] whitespace-normal"
                  >
                    <a
                      href={
                        '/admin/settings/certificate?' +
                        new URLSearchParams({
                          organization: row.organization!,
                          course: row.testId ?? '',
                          user: row.userId,
                          tab,
                        })
                      }
                    >
                      {tab === 'certificate' ? 'Редактировать удостоверение' : 'Протокол компании'}
                    </a>
                  </Button>
                ))}
              </div>
            ) : null}
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
                    <p
                      role="alert"
                      className="flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-danger)]"
                    >
                      История не загрузилась.
                      <button
                        type="button"
                        className="min-h-11 font-semibold underline underline-offset-4"
                        onClick={() => setHistoryAttempt((value) => value + 1)}
                      >
                        Повторить
                      </button>
                    </p>
                  ) : history.state !== 'ready' ? (
                    <p className="py-2.5 text-sm text-[var(--color-text-muted)]">Загружаем…</p>
                  ) : history.items.length > 0 ? (
                    <ol className="divide-y divide-[var(--color-border)]">
                      {history.items.map((certificate) => (
                        <li
                          key={certificate.id}
                          className="flex flex-wrap items-center justify-between gap-3 py-2.5 text-sm"
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
          </div>
          {/* Destructive work stays last, under everything the card is read for. */}
          {canDeleteHistory || canDeleteUser ? (
            <section
              aria-label="Удаление данных"
              className="min-w-0 space-y-3 border-t border-[var(--color-danger)]/30 pt-6 lg:col-span-2"
            >
              <h3 className="font-semibold text-[var(--color-danger)]">Удаление данных</h3>
              {mode === 'delete-history' ? (
                <div
                  ref={dangerRef}
                  className="min-w-0 [&_button]:h-auto [&_button]:min-h-11 [&_button]:max-w-full [&_button]:px-3 [&_button]:py-2 [&_button]:whitespace-normal"
                >
                  <LearningHistoryControl
                    variant="confirm"
                    userId={row.userId}
                    userLabel={row.fullName}
                    onCancel={() => setMode('view')}
                    onDeleted={onHistoryDeleted}
                  />
                </div>
              ) : (
                // The same look as «Удалить сотрудников» in the selection panel:
                // one destructive style across the screen.
                <div className="flex flex-wrap gap-2">
                  {canDeleteHistory ? (
                    <Button
                      ref={deleteHistoryRef}
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 max-w-full px-3 py-2 [overflow-wrap:anywhere] whitespace-normal text-[var(--color-danger)]"
                      onClick={() => setMode('delete-history')}
                    >
                      <Trash /> Удалить учебную историю
                    </Button>
                  ) : null}
                  {canDeleteUser ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-auto min-h-11 max-w-full px-3 py-2 [overflow-wrap:anywhere] whitespace-normal text-[var(--color-danger)]"
                      onClick={() => onAction(row, { kind: 'bulk-delete' })}
                    >
                      <Trash /> Удалить сотрудника
                    </Button>
                  ) : null}
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>

      {nextStep && mode === 'view' ? (
        <footer className="flex shrink-0 flex-col gap-2 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 pt-3 pb-[calc(0.75rem+var(--safe-area-bottom))] sm:flex-row sm:items-center sm:justify-end sm:gap-3 sm:px-5 sm:pb-3">
          {/* «Подтвердить и выдать» runs without a dialog, and the card stays
              open until the answer comes, so its refusal is reported here. */}
          {error ? (
            <p role="alert" className="min-w-0 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
          <Button
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            className="h-auto min-h-11 w-full px-3 py-2 whitespace-normal sm:w-auto"
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
  ...props
}: DetailProps & { row: AdminAttestationRow | null }) {
  const { onClose } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (row && dialog && !dialog.open) {
      dialog.showModal();
      // Focus lands on "close", not on the first button in the header, which
      // would put the card into edit mode on an accidental Enter. A card that
      // opens on a refused issuance starts on the field at fault instead.
      (
        dialog.querySelector<HTMLElement>('[aria-invalid="true"]:enabled') ??
        dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
      )?.focus();
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
        <AttestationDetailContent key={row.recordId} row={row} titleId={titleId} {...props} />
      ) : null}
    </dialog>
  );
}
