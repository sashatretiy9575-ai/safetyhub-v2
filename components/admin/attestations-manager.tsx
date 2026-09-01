'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type {
  AdminAttestationPage,
  AdminAttestationRow,
  AdminAttestationSelection,
  AdminAttestationMutationItem,
} from '@/features/admin/types';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import {
  assertCertificateExportMetadata,
  type CertificateExportMetadata,
} from '@/lib/pdf/certificate-client-contract';
import {
  downloadCertificateExportInBrowser,
  requestCertificateArchiveFileHandle,
} from '@/lib/pdf/certificate-client';
import { formatDateTime } from '@/lib/utils';
import {
  AttestationsActionDialog,
  type AttestationDialogConfig,
} from './attestations-action-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAttestationsModalFocus } from './use-attestations-modal-focus';
import {
  AttestationBulkActionButtons,
  AttestationDetailDrawer,
  AttestationRowActions,
  AttestationWorkflowBadge,
  attestationFieldLabels,
  type AttestationIdentityFields,
  type AttestationPendingAction,
  type AttestationPermissions,
  type AttestationSelectionSummary,
} from './attestations-manager-panels';

type FilterSnapshot = {
  query: string;
  organization: string;
  testId: string | null;
  resultState: 'passed' | 'failed' | null;
  certificateState: 'pending_identity' | 'ready' | 'issued' | 'revoked' | null;
  from: string | null;
  to: string | null;
  sort:
    | 'name_asc'
    | 'organization_asc'
    | 'completed_desc'
    | 'completed_asc'
    | 'score_desc'
    | 'score_asc';
  pageSize: 25 | 50 | 100;
};

type CertificateExportJob = {
  id: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  requested: number;
  eligible: number;
  skipped: number;
  expiresAt: string;
  downloadUrl: string;
};

function organizationGroupKey(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function organizationHref(filters: FilterSnapshot, organization: string) {
  const params = new URLSearchParams();
  if (filters.query) params.set('q', filters.query);
  if (organization) params.set('organization', organization);
  if (filters.testId) params.set('course', filters.testId);
  if (filters.resultState) params.set('result', filters.resultState);
  if (filters.certificateState) params.set('certificate', filters.certificateState);
  if (filters.from) params.set('from', filters.from.slice(0, 10));
  if (filters.to) {
    const inclusiveEnd = new Date(filters.to);
    inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() - 1);
    params.set('to', inclusiveEnd.toISOString().slice(0, 10));
  }
  if (filters.sort !== 'completed_desc') params.set('sort', filters.sort);
  if (filters.pageSize !== 50) params.set('pageSize', String(filters.pageSize));
  return `/admin/employees?${params.toString()}`;
}

export function AttestationsManager({
  page,
  filters,
  permissions,
}: {
  page: AdminAttestationPage;
  filters: FilterSnapshot;
  permissions: AttestationPermissions;
}) {
  const router = useRouter();
  const [clientReady, setClientReady] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolvedSelection, setResolvedSelection] = useState<AdminAttestationSelection | null>(
    null,
  );
  const [selectingAll, setSelectingAll] = useState(false);
  const [pending, setPending] = useState<AttestationPendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(
    null,
  );
  const [detail, setDetail] = useState<AdminAttestationRow | null>(null);
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const bulkActionsTriggerRef = useRef<HTMLButtonElement>(null);
  const bulkActionsPanelRef = useRef<HTMLElement>(null);
  const closeBulkActions = useCallback(() => setBulkActionsOpen(false), []);
  const idempotencyKeyRef = useRef('');
  const exportAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setClientReady(true);
  }, []);
  useEffect(() => {
    idempotencyKeyRef.current = pending ? crypto.randomUUID() : '';
  }, [pending]);
  useAttestationsModalFocus({
    open: bulkActionsOpen,
    panelRef: bulkActionsPanelRef,
    triggerRef: bulkActionsTriggerRef,
    onClose: closeBulkActions,
  });

  const selectedRows = useMemo(
    () => page.items.filter((row) => selected.has(row.recordId)),
    [page.items, selected],
  );
  const pageSelected =
    page.items.length > 0 && page.items.every((row) => selected.has(row.recordId));
  const selectedCount = resolvedSelection?.total ?? selected.size;
  const userIds =
    resolvedSelection?.userIds ??
    unique(selectedRows.filter((row) => !row.courseDeleted).map((row) => row.userId));
  const recordIds = resolvedSelection?.recordIds ?? selectedRows.map((row) => row.recordId);
  const attestationIds =
    resolvedSelection?.attestationIds ??
    selectedRows.flatMap((row) => (row.attestationId ? [row.attestationId] : []));
  const certificateIds =
    resolvedSelection?.certificateIds ??
    selectedRows.flatMap((row) =>
      row.certificateState === 'issued' && row.certificateId ? [row.certificateId] : [],
    );
  const selectionSummary = useMemo<AttestationSelectionSummary>(() => {
    if (resolvedSelection) {
      return {
        total: resolvedSelection.total,
        people: resolvedSelection.uniquePeople,
        pendingIdentity: resolvedSelection.pendingIdentity,
        readyToIssue: resolvedSelection.ready,
        issued: resolvedSelection.issued,
        exportable: resolvedSelection.exportable,
      };
    }
    const issued = selectedRows.filter(
      (row) => row.certificateState === 'issued' && Boolean(row.certificateId),
    ).length;

    return {
      total: selectedCount,
      people: userIds.length,
      pendingIdentity: unique(
        selectedRows.filter((row) => row.identityState !== 'verified').map((row) => row.userId),
      ).length,
      readyToIssue: selectedRows.filter(
        (row) =>
          !row.courseDeleted &&
          (row.certificateState === 'ready' || row.certificateState === 'revoked'),
      ).length,
      issued,
      exportable: issued,
    };
  }, [resolvedSelection, selectedCount, selectedRows, userIds.length]);

  const setRowSelected = (row: AdminAttestationRow, checked: boolean) => {
    setResolvedSelection(null);
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(row.recordId);
      else next.delete(row.recordId);
      return next;
    });
  };

  const setPageSelected = (checked: boolean) => {
    setResolvedSelection(null);
    setSelected(checked ? new Set(page.items.map((row) => row.recordId)) : new Set());
  };

  const resolveFilteredSelection = async (
    selectionFilters: FilterSnapshot,
    visibleIds: string[],
    successMessage: (selection: AdminAttestationSelection) => string,
  ) => {
    setSelectingAll(true);
    setMessage('');
    try {
      const result = await clientRequest('/api/admin/attestations/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(selectionFilters),
      });
      const payload = await readClientResponseJson<AdminAttestationSelection | { error?: string }>(
        result.response,
      );
      if (!result.ok || !payload || !('attestationIds' in payload)) {
        setMessage(
          result.ok
            ? 'Сервер вернул неполный список.'
            : clientRequestMessage(result.error, 'Не удалось выбрать строки по фильтру.'),
        );
        return;
      }
      setResolvedSelection(payload);
      setSelected(new Set(visibleIds));
      setMessage(successMessage(payload));
    } catch (requestError) {
      setMessage(clientRequestMessage(requestError, 'Не удалось выбрать строки по фильтру.'));
    } finally {
      setSelectingAll(false);
    }
  };

  const setOrganizationGroupSelected = async (organization: string, checked: boolean) => {
    if (!checked) {
      clearSelection();
      return;
    }
    const key = organizationGroupKey(organization);
    const groupRows = page.items.filter((row) => organizationGroupKey(row.organization) === key);
    await resolveFilteredSelection(
      { ...filters, organization },
      groupRows.map((row) => row.recordId),
      (selection) =>
        `Выбрана компания «${organization || 'не указана'}»: ${selection.total} строк.`,
    );
  };

  const selectAllFiltered = async () => {
    if (page.total > 500) {
      setMessage('За один раз можно обработать не более 500 строк. Уточните фильтр.');
      return;
    }
    await resolveFilteredSelection(
      filters,
      page.items.map((row) => row.recordId),
      (selection) => `Выбраны все строки по текущему фильтру: ${selection.total}.`,
    );
  };

  const clearSelection = () => {
    setSelected(new Set());
    setResolvedSelection(null);
    setMessage('');
    setBulkActionsOpen(false);
  };

  const openSingleAction = (row: AdminAttestationRow, action: AttestationPendingAction) => {
    setSelected(new Set([row.recordId]));
    setResolvedSelection(null);
    setPending(action);
    setError('');
    setBulkActionsOpen(false);
  };

  const dialogConfig = useMemo<AttestationDialogConfig | null>(() => {
    if (!pending) return null;
    if (pending.kind === 'confirm') {
      return {
        title: 'Подтвердить данные',
        description: `Выбрано ${selectionSummary.people} человек. Подтверждение применимо к ${selectionSummary.pendingIdentity}. Сертификаты станут доступны к выдаче только для сданных курсов.`,
        confirmLabel: `Подтвердить ${selectionSummary.pendingIdentity}`,
      };
    }
    if (pending.kind === 'bulk-update') {
      return {
        title: `Изменить поле «${attestationFieldLabels[pending.field]}»`,
        description: `Новое значение будет применено к ${selectionSummary.people} людям. Действующие сертификаты будут отозваны и перевыпущены с новыми номерами.`,
        confirmLabel: 'Сохранить изменение',
        input: { label: `Новое значение: ${attestationFieldLabels[pending.field]}` },
      };
    }
    if (pending.kind === 'individual-update') {
      const oldValue = pending.row[pending.field];
      return {
        title: `Изменить поле «${attestationFieldLabels[pending.field]}»`,
        description: `Текущее значение: «${oldValue || 'не указано'}». Действующие сертификаты этого человека будут перевыпущены.`,
        confirmLabel: 'Сохранить изменение',
        input: {
          label: `Новое значение: ${attestationFieldLabels[pending.field]}`,
          initialValue: oldValue,
        },
      };
    }
    if (pending.kind === 'issue') {
      return {
        title: 'Выдать сертификаты',
        description: `Выбрано ${selectionSummary.total} результатов. Сейчас выдача применима к ${selectionSummary.readyToIssue}; ожидаемо будет пропущено ${Math.max(0, selectionSummary.total - selectionSummary.readyToIssue)}. Сервер повторно проверит каждую строку перед выдачей.`,
        confirmLabel: `Выдать ${selectionSummary.readyToIssue}`,
      };
    }
    if (pending.kind === 'revoke')
      return {
        title: 'Отозвать сертификаты',
        description: `Будет обработано ${selectionSummary.issued} действующих сертификатов. После отзыва они исчезнут из кабинетов пользователей, а причина и идентификатор операции попадут в историю действий.`,
        confirmLabel: `Отозвать ${selectionSummary.issued}`,
        tone: 'danger',
        reason: true,
        confirmationPhrase:
          selectionSummary.issued >= 20 ? `ОТОЗВАТЬ ${selectionSummary.issued}` : undefined,
      };
    return {
      title: 'Скачать пакет документов',
      description: `Выбрано строк: ${selectionSummary.total}. Действующих сертификатов: ${selectionSummary.exportable}. Строки без действующего сертификата не войдут в ZIP. Даже при нуле сертификатов архив содержит общий отчёт.`,
      confirmLabel: 'Сформировать ZIP',
    };
  }, [pending, selectionSummary]);

  const mutationSummary = (
    items: AdminAttestationMutationItem[],
    kind: AttestationPendingAction['kind'],
  ) => {
    const completed = items.filter((item) => item.status === 'completed').length;
    const already = items.filter((item) => item.status === 'already_completed').length;
    const skipped = items.filter((item) => item.status === 'skipped').length;
    const actionLabel = {
      confirm: 'Данные подтверждены',
      'bulk-update': 'Данные обновлены',
      'individual-update': 'Данные обновлены',
      issue: 'Готово: сертификаты выданы',
      revoke: 'Готово: сертификаты отозваны',
      export: 'Архив сформирован',
    }[kind];
    const reasons = items
      .filter((item) => item.status === 'skipped' && item.reason)
      .reduce<Record<string, number>>((result, item) => {
        const code = item.reason ?? 'STATE_CHANGED';
        const label = /IDENTITY|pending_identity/u.test(code)
          ? 'данные не подтверждены'
          : /ELIGIBLE|PASS|not_eligible/u.test(code)
            ? 'тест не сдан'
            : /ACCOUNT|SUSPEND|DELETION/u.test(code)
              ? 'аккаунт недоступен'
              : 'состояние изменилось';
        result[label] = (result[label] ?? 0) + 1;
        return result;
      }, {});
    const reasonText = Object.entries(reasons)
      .map(([label, count]) => `${count} — ${label}`)
      .join('; ');
    return `${actionLabel}: ${completed}. Без изменений: ${already}. Пропущено: ${skipped}.${reasonText ? ` Причины: ${reasonText}.` : ''}`;
  };

  const confirmAction = async ({ value, reason }: { value: string; reason: string }) => {
    if (!pending) return;
    if (pending.kind === 'export') {
      setPending(null);
      await downloadZip();
      return;
    }
    setBusy(true);
    setError('');
    const actionKind = pending.kind;
    const idempotencyKey = idempotencyKeyRef.current || crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    const body =
      pending.kind === 'confirm'
        ? { action: 'confirm', userIds, idempotencyKey }
        : pending.kind === 'bulk-update'
          ? { action: 'update', userIds, field: pending.field, value, idempotencyKey }
          : pending.kind === 'individual-update'
            ? {
                action: 'update',
                userIds: [pending.row.userId],
                field: pending.field,
                value,
                idempotencyKey,
              }
            : pending.kind === 'issue'
              ? { action: 'issue', attestationIds, idempotencyKey }
              : { action: 'revoke', certificateIds, reason, idempotencyKey };
    try {
      const result = await clientRequest('/api/admin/attestations/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await readClientResponseJson<{
        error?: string;
        items?: AdminAttestationMutationItem[];
      }>(result.response);
      if (!result.ok) {
        setError(clientRequestMessage(result.error, 'Операция не выполнена. Проверьте выбор.'));
        return;
      }
      if (!payload?.items) {
        setError('Сервер вернул неполный результат. Обновите страницу и проверьте данные.');
        return;
      }
      const summary = mutationSummary(payload.items, actionKind);
      setPending(null);
      setDetail(null);
      clearSelection();
      setMessage(summary);
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Операция не выполнена.'));
    } finally {
      setBusy(false);
    }
  };

  const downloadZip = async () => {
    if (recordIds.length === 0) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setBusy(true);
    setExportProgress({ completed: 0, total: selectionSummary.exportable });
    setMessage('Получаем данные сертификатов. PDF и ZIP будут сформированы только в браузере…');
    try {
      const fileHandle = await requestCertificateArchiveFileHandle(
        `safetyhub-certificates-${new Date().toISOString().slice(0, 10)}.zip`,
      );
      let metadataResponse: Response | undefined;
      if (recordIds.length > 100) {
        const jobResult = await clientRequest(
          '/api/admin/attestations/export-jobs',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ attestationIds: recordIds }),
          },
          { timeoutMs: 30_000, signal: controller.signal },
        );
        const job = await readClientResponseJson<CertificateExportJob | { error?: string }>(
          jobResult.response,
        );
        if (!jobResult.ok || !job || !('downloadUrl' in job)) {
          setMessage(
            jobResult.ok
              ? 'Сервер вернул неполные данные большого экспорта.'
              : clientRequestMessage(jobResult.error, 'Не удалось подготовить большой экспорт.'),
          );
          return;
        }
        const metadataResult = await clientRequest(
          job.downloadUrl,
          { headers: { Accept: 'application/json' } },
          { timeoutMs: 60_000, signal: controller.signal },
        );
        if (!metadataResult.ok) {
          setMessage(clientRequestMessage(metadataResult.error, 'Не удалось получить данные экспорта.'));
          return;
        }
        metadataResponse = metadataResult.response;
      } else {
        const metadataResult = await clientRequest(
          '/api/admin/attestations/export',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ attestationIds: recordIds }),
          },
          { timeoutMs: 60_000, signal: controller.signal },
        );
        if (!metadataResult.ok) {
          setMessage(clientRequestMessage(metadataResult.error, 'Не удалось получить данные экспорта.'));
          return;
        }
        metadataResponse = metadataResult.response;
      }
      const metadata = await readClientResponseJson<CertificateExportMetadata>(metadataResponse);
      assertCertificateExportMetadata(metadata);
      const result = await downloadCertificateExportInBrowser(metadata, {
        fileHandle,
        signal: controller.signal,
        onProgress: (progress) => {
          setExportProgress(progress);
          setMessage(`Формируем сертификаты в браузере: ${progress.completed} из ${progress.total}…`);
        },
      });
      setMessage(
        result.streamed
          ? 'ZIP сформирован в браузере и записан в выбранный файл.'
          : `ZIP сформирован в браузере и передан на скачивание${result.archives > 1 ? ` (${result.archives} частей по 100 сертификатов максимум)` : ''}.`,
      );
    } catch (requestError) {
      if (controller.signal.aborted || (requestError instanceof DOMException && requestError.name === 'AbortError')) {
        setMessage('Формирование ZIP отменено.');
      } else {
        setMessage(clientRequestMessage(requestError, 'Не удалось сформировать ZIP в браузере.'));
      }
    } finally {
      if (exportAbortRef.current === controller) exportAbortRef.current = null;
      setExportProgress(null);
      setBusy(false);
    }
  };

  return (
    <div
      data-attestations-manager
      data-client-ready={clientReady ? 'true' : 'false'}
      className={selectedCount > 0 ? 'space-y-3 pb-28 @min-[960px]:pb-36' : 'space-y-3'}
    >
      {pageSelected && !resolvedSelection && page.total > page.items.length ? (
        <div className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 text-sm">
          <span>Выбрана текущая страница: {page.items.length}.</span>
          <Button size="sm" variant="outline" disabled={selectingAll} onClick={selectAllFiltered}>
            {selectingAll ? 'Выбираем…' : `Выбрать все ${page.total} по фильтру`}
          </Button>
        </div>
      ) : null}

      {message ? (
        <p role="status" className="rounded-xl bg-[var(--color-primary-soft)] px-4 py-3 text-sm">
          {message}
        </p>
      ) : null}

      {exportProgress ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--color-primary)] bg-[var(--color-primary-soft)] px-4 py-3 text-sm">
          <p>
            Формирование в браузере: {exportProgress.completed} из {exportProgress.total} PDF.
          </p>
          <Button size="sm" variant="outline" onClick={() => exportAbortRef.current?.abort()}>
            <X /> Отменить
          </Button>
        </div>
      ) : null}

      <div
        role="table"
        aria-label="Аттестации сотрудников"
        className="space-y-2 @min-[960px]:space-y-0 @min-[960px]:overflow-hidden @min-[960px]:rounded-xl @min-[960px]:border @min-[960px]:bg-[var(--color-surface)]"
      >
        <div
          role="row"
          className="sticky top-0 z-20 hidden min-h-11 items-center gap-x-2 bg-[var(--color-surface)] px-2 text-left text-xs font-bold text-[var(--color-text-muted)] shadow-[0_1px_var(--color-border)] @min-[960px]:grid @min-[960px]:grid-cols-[44px_minmax(0,1.25fr)_minmax(0,.9fr)_minmax(0,1.25fr)_64px_minmax(0,.75fr)_44px]"
        >
          <span role="columnheader" className="grid place-items-center">
            <label className="grid size-11 cursor-pointer place-items-center">
              <input
                type="checkbox"
                checked={pageSelected}
                onChange={(event) => setPageSelected(event.target.checked)}
                className="size-5 accent-[var(--color-primary)]"
              />
              <span className="sr-only">Выбрать текущую страницу</span>
            </label>
          </span>
          <span role="columnheader">Сотрудник</span>
          <span role="columnheader">Компания</span>
          <span role="columnheader">Курс</span>
          <span role="columnheader">Результат</span>
          <span role="columnheader">Статус</span>
          <span role="columnheader" className="sr-only">
            Действия
          </span>
        </div>

        <div role="rowgroup" className="space-y-2 @min-[960px]:space-y-0">
          {page.items.map((row, index) => {
            const groupKey = organizationGroupKey(row.organization);
            const showGroup =
              filters.sort === 'organization_asc' &&
              (index === 0 ||
                groupKey !== organizationGroupKey(page.items[index - 1]?.organization ?? ''));
            const groupRows = showGroup
              ? page.items.filter(
                  (candidate) => organizationGroupKey(candidate.organization) === groupKey,
                )
              : [];
            const groupSelected =
              groupRows.length > 0 &&
              groupRows.every((candidate) => selected.has(candidate.recordId));
            const groupCollapsed = collapsedGroups.has(groupKey);

            return (
              <Fragment key={row.recordId}>
                {showGroup ? (
                  <div
                    role="row"
                    className="rounded-lg bg-[var(--color-surface-muted)] @min-[960px]:rounded-none"
                  >
                    <div
                      role="cell"
                      className="flex min-h-11 items-center gap-2 px-2 py-1 text-xs font-bold"
                    >
                      <label className="grid size-11 shrink-0 cursor-pointer place-items-center">
                        <input
                          type="checkbox"
                          checked={groupSelected}
                          onChange={(event) =>
                            void setOrganizationGroupSelected(
                              row.organization,
                              event.target.checked,
                            )
                          }
                          disabled={selectingAll}
                          className="size-5 accent-[var(--color-primary)]"
                        />
                        <span className="sr-only">
                          Выбрать компанию: {row.organization || 'не указана'}
                        </span>
                      </label>
                      <button
                        type="button"
                        aria-expanded={!groupCollapsed}
                        aria-label={`${groupCollapsed ? 'Развернуть' : 'Свернуть'} компанию ${row.organization || 'не указана'}`}
                        onClick={() =>
                          setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(groupKey)) next.delete(groupKey);
                            else next.add(groupKey);
                            return next;
                          })
                        }
                        className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-[var(--color-surface)]"
                      >
                        <CaretDown
                          size={18}
                          className={
                            groupCollapsed
                              ? '-rotate-90 transition-transform'
                              : 'transition-transform'
                          }
                        />
                      </button>
                      <Link
                        href={organizationHref(filters, row.organization)}
                        className="min-h-11 min-w-0 flex-1 content-center break-words text-[var(--color-primary)] underline-offset-4 hover:underline"
                      >
                        {row.organization || 'Компания не указана'} · {row.organizationGroupCount}{' '}
                        строк
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Действия с компанией: ${row.organization || 'не указана'}`}
                          >
                            <DotsThree size={20} weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() =>
                              void setOrganizationGroupSelected(row.organization, true)
                            }
                          >
                            Выбрать всю компанию
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href={organizationHref(filters, row.organization)}>
                              Показать только компанию
                            </Link>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                ) : null}

                {!groupCollapsed ? (
                  <article
                    role="row"
                    className="grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] gap-x-2 gap-y-1 rounded-xl border bg-[var(--color-surface)] p-3 text-sm shadow-[var(--shadow-soft)] transition-colors hover:bg-[var(--color-surface-muted)]/60 @min-[960px]:min-h-[56px] @min-[960px]:grid-cols-[44px_minmax(0,1.25fr)_minmax(0,.9fr)_minmax(0,1.25fr)_64px_minmax(0,.75fr)_44px] @min-[960px]:items-center @min-[960px]:gap-x-2 @min-[960px]:rounded-none @min-[960px]:border-0 @min-[960px]:border-t @min-[960px]:p-2 @min-[960px]:shadow-none"
                    onClick={(event) => {
                      const target = event.target as HTMLElement;
                      if (!target.closest('button, input, a, [role="menuitem"]')) setDetail(row);
                    }}
                  >
                    <div
                      role="cell"
                      className="col-start-1 row-start-1 @min-[960px]:col-start-1 @min-[960px]:row-start-1 @min-[960px]:grid @min-[960px]:place-items-center"
                    >
                      <label className="grid size-11 cursor-pointer place-items-center">
                        <input
                          type="checkbox"
                          checked={selected.has(row.recordId)}
                          onChange={(event) => setRowSelected(row, event.target.checked)}
                          className="size-5 accent-[var(--color-primary)]"
                        />
                        <span className="sr-only">
                          Выбрать: {row.fullName}, {row.courseTitle}
                        </span>
                      </label>
                    </div>

                    <div
                      role="cell"
                      className="col-start-2 row-start-1 min-w-0 @min-[960px]:col-start-2 @min-[960px]:row-start-1"
                    >
                      <button
                        type="button"
                        onClick={() => setDetail(row)}
                        aria-label={`Открыть сведения: ${row.fullName}`}
                        className="flex min-h-10 min-w-0 items-center gap-2 text-left hover:underline"
                      >
                        <span className="min-w-0">
                          <span className="block font-bold break-words">{row.fullName}</span>
                          <span className="block text-xs text-[var(--color-text-muted)] @min-[960px]:line-clamp-1">
                            {row.job || 'Должность не указана'}
                          </span>
                        </span>
                      </button>
                    </div>

                    <div
                      role="cell"
                      className="col-start-2 col-end-3 row-start-2 min-w-0 @min-[960px]:col-start-3 @min-[960px]:col-end-4 @min-[960px]:row-start-1"
                    >
                      {row.organization ? (
                        <Link
                          href={organizationHref(filters, row.organization)}
                          className="inline-flex min-h-9 max-w-full items-center truncate text-[var(--color-primary)] underline-offset-4 hover:underline"
                          title="Показать только эту компанию"
                        >
                          {row.organization}
                        </Link>
                      ) : (
                        <span className="text-[var(--color-text-muted)]">Компания не указана</span>
                      )}
                    </div>

                    <div
                      role="cell"
                      className="col-start-1 col-end-3 row-start-3 min-w-0 border-t pt-2 @min-[960px]:col-start-4 @min-[960px]:col-end-5 @min-[960px]:row-start-1 @min-[960px]:border-0 @min-[960px]:pt-0"
                    >
                      <p className="font-semibold break-words">{row.courseTitle}</p>
                      <p className="text-[11px] text-[var(--color-text-subtle)]">
                        {formatDateTime(row.completedAt)}
                      </p>
                    </div>

                    <div
                      role="cell"
                      className="col-start-3 row-start-3 border-t pt-2 text-right @min-[960px]:col-start-5 @min-[960px]:row-start-1 @min-[960px]:border-0 @min-[960px]:pt-0 @min-[960px]:text-left"
                    >
                      <span className="text-base font-black tabular-nums">
                        {row.score}/{row.total}
                      </span>
                      <span className="block text-xs text-[var(--color-text-subtle)]">
                        порог {row.passScore}
                      </span>
                    </div>

                    <div
                      role="cell"
                      className="col-start-3 row-start-2 flex justify-end @min-[960px]:col-start-6 @min-[960px]:col-end-7 @min-[960px]:row-start-1 @min-[960px]:justify-start"
                    >
                      <AttestationWorkflowBadge row={row} />
                    </div>

                    <div
                      role="cell"
                      className="col-start-3 row-start-1 @min-[960px]:col-start-7 @min-[960px]:row-start-1"
                    >
                      <AttestationRowActions
                        row={row}
                        permissions={permissions}
                        openDetails={() => setDetail(row)}
                        openAction={(action) => openSingleAction(row, action)}
                      />
                    </div>
                  </article>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </div>

      {selectedCount > 0 ? (
        <>
          <aside
            aria-label="Выбранные аттестации"
            className="glass-strong sticky bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+.5rem)] z-30 flex items-center gap-3 rounded-2xl border p-3 shadow-[var(--shadow-pop)] @min-[960px]:hidden"
          >
            <div className="min-w-0 flex-1">
              <p className="font-bold tabular-nums">Выбрано: {selectedCount}</p>
              <p className="truncate text-xs text-[var(--color-text-muted)]">
                {selectionSummary.people} чел. · PDF: {selectionSummary.exportable}
              </p>
            </div>
            <Button ref={bulkActionsTriggerRef} size="sm" onClick={() => setBulkActionsOpen(true)}>
              Действия
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={clearSelection}
              aria-label="Снять выделение"
            >
              <X />
            </Button>
          </aside>

          <aside
            aria-label="Массовые действия"
            className="glass-strong sticky bottom-4 z-30 hidden rounded-2xl border p-4 shadow-[var(--shadow-pop)] @min-[960px]:block"
          >
            <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b pb-3 text-sm">
              <strong>{selectionSummary.total} выбрано</strong>
              <span className="text-[var(--color-text-muted)]">
                {selectionSummary.people} чел. · проверить {selectionSummary.pendingIdentity} ·
                выдать {selectionSummary.readyToIssue} · PDF {selectionSummary.exportable}
              </span>
            </div>
            <AttestationBulkActionButtons
              summary={selectionSummary}
              permissions={permissions}
              busy={busy}
              onAction={setPending}
              onClear={clearSelection}
            />
          </aside>

          {bulkActionsOpen ? (
            <div
              className="fixed inset-0 z-50 grid items-end bg-black/45 @min-[960px]:hidden"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeBulkActions();
              }}
            >
              <section
                ref={bulkActionsPanelRef}
                tabIndex={-1}
                role="dialog"
                aria-modal="true"
                aria-labelledby="bulk-actions-title"
                className="max-h-[85dvh] overflow-y-auto rounded-t-3xl bg-[var(--color-surface)] p-4 pb-[calc(1rem+var(--safe-area-bottom))] shadow-[var(--shadow-pop)]"
              >
                <header className="mb-4 flex items-start justify-between gap-3">
                  <h2 id="bulk-actions-title" className="text-lg font-bold">
                    Действия · {selectionSummary.total}
                  </h2>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={closeBulkActions}
                    aria-label="Закрыть действия"
                    data-modal-initial-focus
                  >
                    <X />
                  </Button>
                </header>
                <p className="mb-4 rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm text-[var(--color-text-muted)]">
                  {selectionSummary.people} чел. · проверить {selectionSummary.pendingIdentity} ·
                  выдать {selectionSummary.readyToIssue} · PDF {selectionSummary.exportable}
                </p>
                <AttestationBulkActionButtons
                  summary={selectionSummary}
                  permissions={permissions}
                  busy={busy}
                  onAction={(action) => {
                    setBulkActionsOpen(false);
                    setPending(action);
                  }}
                  onClear={clearSelection}
                  compact
                />
              </section>
            </div>
          ) : null}
        </>
      ) : null}

      <AttestationDetailDrawer
        row={detail}
        permissions={permissions}
        onClose={() => setDetail(null)}
        onSaved={(row, fields: AttestationIdentityFields) => {
          setDetail((current) =>
            current?.userId === row.userId
              ? {
                  ...current,
                  ...fields,
                  fullName: `${fields.name} ${fields.surname}`.trim(),
                  identityState: 'verified',
                }
              : current,
          );
          router.refresh();
        }}
        onHistoryDeleted={() => {
          setDetail(null);
          clearSelection();
          router.refresh();
        }}
      />
      <AttestationsActionDialog
        config={dialogConfig}
        busy={busy}
        error={error}
        onCancel={() => {
          setPending(null);
          setError('');
        }}
        onConfirm={confirmAction}
      />
    </div>
  );
}
