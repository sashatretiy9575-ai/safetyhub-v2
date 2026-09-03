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
import { AttestationSelectionBanner } from './attestation-selection-banner';
import { AttestationTableRow } from './attestation-table-row';
import { useAttestationsModalFocus } from './use-attestations-modal-focus';
import {
  AttestationBulkActionButtons,
  AttestationDetailDrawer,
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

function levenshteinDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = b.length;
  const n = a.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, idx) => idx);

  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, (dp[j - 1] ?? 0) + 1, temp + 1);
      }
      prev = temp;
    }
  }
  return dp[n] ?? 99;
}

function findCompanyTypoWarnings(rows: AdminAttestationRow[]) {
  const orgCounts = new Map<string, number>();
  for (const row of rows) {
    const org = (row.organization ?? '').trim();
    if (org) orgCounts.set(org, (orgCounts.get(org) ?? 0) + 1);
  }
  const orgs = Array.from(orgCounts.keys());
  const warnings: Array<{ primary: string; primaryCount: number; typo: string; typoCount: number }> = [];

  for (let i = 0; i < orgs.length; i++) {
    const a = orgs[i];
    if (!a) continue;
    for (let j = i + 1; j < orgs.length; j++) {
      const b = orgs[j];
      if (!b) continue;
      const normA = a.toLowerCase().replace(/[\s\-_"«»]/g, '');
      const normB = b.toLowerCase().replace(/[\s\-_"«»]/g, '');
      if (normA !== normB && (normA.includes(normB) || normB.includes(normA) || levenshteinDistance(normA, normB) <= 2)) {
        const countA = orgCounts.get(a) ?? 0;
        const countB = orgCounts.get(b) ?? 0;
        if (countA >= countB) {
          warnings.push({ primary: a, primaryCount: countA, typo: b, typoCount: countB });
        } else {
          warnings.push({ primary: b, primaryCount: countB, typo: a, typoCount: countA });
        }
      }
    }
  }
  return warnings;
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

  // The list is a company sheet: rows are banded by company and the company
  // column disappears from the rows themselves, because the band already names it.
  const grouped = filters.sort === 'organization_asc';

  const selectedRows = useMemo(
    () => page.items.filter((row) => selected.has(row.recordId)),
    [page.items, selected],
  );
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
    const key = organizationGroupKey(organization);
    if (!checked) {
      // Unticking one company must not wipe an unrelated selection. A resolved
      // "all filtered rows" selection is server-side and cannot be narrowed, so
      // that one is still dropped whole.
      if (resolvedSelection) {
        clearSelection();
        return;
      }
      setSelected((current) => {
        const next = new Set(current);
        for (const item of page.items) {
          if (organizationGroupKey(item.organization) === key) next.delete(item.recordId);
        }
        return next;
      });
      return;
    }
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
      const typoWarnings = findCompanyTypoWarnings(selectedRows);
      const firstWarning = typoWarnings[0];
      const warningText =
        firstWarning
          ? ` ⚠️ Внимание: обнаружены похожие компании («${firstWarning.primary}» — ${firstWarning.primaryCount} чел. и «${firstWarning.typo}» — ${firstWarning.typoCount} чел.). Возможно, это опечатка в названии. Рекомендуем объединить перед выдачей.`
          : '';
      return {
        title: 'Выдать сертификаты',
        description: `Выбрано ${selectionSummary.total} результатов. Сейчас выдача применима к ${selectionSummary.readyToIssue}; ожидаемо будет пропущено ${Math.max(0, selectionSummary.total - selectionSummary.readyToIssue)}.${warningText}`,
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
    if (pending.kind === 'bulk-delete') {
      return {
        title: 'Удалить пользователей',
        description: `Выбрано пользователей для удаления: ${selectionSummary.people}. Все связанные данные, попытки и профили будут удалены. Это действие необратимо.`,
        confirmLabel: `Удалить ${selectionSummary.people} пользователей`,
        tone: 'danger',
        confirmationPhrase:
          selectionSummary.people >= 5 ? `УДАЛИТЬ ${selectionSummary.people}` : undefined,
      };
    }
    return {
      title: 'Скачать пакет документов',
      description: `Выбрано строк: ${selectionSummary.total}. Действующих сертификатов: ${selectionSummary.exportable}. Строки без действующего сертификата не войдут в ZIP. Даже при нуле сертификатов архив содержит общий отчёт.`,
      confirmLabel: 'Сформировать ZIP',
    };
  }, [pending, selectedRows, selectionSummary]);

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
      'bulk-delete': 'Пользователи удалены',
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
    if (pending.kind === 'bulk-delete') {
      setBusy(true);
      setError('');
      try {
        let deleted = 0;
        let failed = 0;
        for (const targetUserId of userIds) {
          const res = await clientRequest(`/api/admin/users/${targetUserId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || 'Массовое удаление пользователей администратором' }),
          });
          if (res.ok) deleted++;
          else failed++;
        }
        setPending(null);
        setDetail(null);
        clearSelection();
        setMessage(`Удалено пользователей: ${deleted}.${failed > 0 ? ` Ошибок: ${failed}.` : ''}`);
        router.refresh();
      } catch {
        setError('Не удалось удалить пользователей.');
      } finally {
        setBusy(false);
      }
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
      className={selectedCount > 0 ? 'space-y-3 pb-28 @min-[760px]:pb-36' : 'space-y-3'}
    >
      <AttestationSelectionBanner
        selectedCount={selectedCount}
        totalFiltered={page.total}
        pageSize={page.items.length}
        isAllFilteredSelected={Boolean(resolvedSelection)}
        selectingAll={selectingAll}
        onSelectAllFiltered={selectAllFiltered}
        onClearSelection={clearSelection}
      />

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
        className="space-y-2 @min-[760px]:space-y-0 @min-[760px]:overflow-hidden @min-[760px]:rounded-xl @min-[760px]:border @min-[760px]:bg-[var(--color-surface)]"
      >
        <div
          role="row"
          className="sticky top-0 z-20 hidden min-h-9 items-center gap-x-2 bg-[var(--color-surface-muted)] px-1.5 text-left text-xs font-bold text-[var(--color-text-muted)] shadow-[0_1px_var(--color-border)] @min-[760px]:grid @min-[760px]:grid-cols-[32px_minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(0,1.25fr)_6.5rem_44px_minmax(0,0.9fr)_32px]"
        >
          {/* An `sr-only` cell is absolutely positioned and therefore leaves the
              grid flow, which shifted every visible heading one column to the
              left. Keep the cell in flow and hide only its text. */}
          <span role="columnheader" aria-label="Выбор" />
          <span role="columnheader">Сотрудник</span>
          <span role="columnheader" className="border-l border-[var(--color-border)] pl-2">
            {grouped ? 'Должность' : 'Компания'}
          </span>
          <span role="columnheader" className="border-l border-[var(--color-border)] pl-2">
            Курс
          </span>
          <span role="columnheader" className="border-l border-[var(--color-border)] pl-2">
            Дата
          </span>
          <span role="columnheader" className="border-l border-[var(--color-border)] pl-2">
            Балл
          </span>
          <span role="columnheader" className="border-l border-[var(--color-border)] pl-2">
            Статус
          </span>
          <span role="columnheader" aria-label="Действия" />
        </div>

        <div
          role="rowgroup"
          className={`space-y-2 @min-[760px]:space-y-0 ${selectionSummary.total > 0 ? 'pb-24 @min-[760px]:pb-16' : ''}`}
        >
          {page.items.map((row, index) => {
            const groupKey = organizationGroupKey(row.organization);
            const showGroup =
              grouped &&
              (index === 0 ||
                groupKey !== organizationGroupKey(page.items[index - 1]?.organization ?? ''));
            const groupCollapsed = collapsedGroups.has(groupKey);
            const groupRowIds = showGroup
              ? page.items
                  .filter((item) => organizationGroupKey(item.organization) === groupKey)
                  .map((item) => item.recordId)
              : [];
            const groupFullySelected =
              showGroup &&
              groupRowIds.length > 0 &&
              groupRowIds.every((recordId) => selected.has(recordId));

            return (
              <Fragment key={row.recordId}>
                {showGroup ? (
                  <div
                    role="row"
                    className="rounded-lg bg-[var(--color-surface-muted)] @min-[760px]:rounded-none @min-[760px]:border-t-2 @min-[760px]:border-[var(--color-border-strong)]"
                  >
                    <div
                      role="cell"
                      className="flex min-h-10 items-center gap-1 px-1.5 text-xs font-bold"
                    >
                      <button
                        type="button"
                        aria-expanded={!groupCollapsed}
                        aria-label={`${groupCollapsed ? 'Развернуть' : 'Свернуть'} компанию ${row.organization || '—'}`}
                        onClick={() =>
                          setCollapsedGroups((current) => {
                            const next = new Set(current);
                            if (next.has(groupKey)) next.delete(groupKey);
                            else next.add(groupKey);
                            return next;
                          })
                        }
                        className="grid size-9 shrink-0 place-items-center rounded-lg hover:bg-[var(--color-surface)]"
                      >
                        <CaretDown
                          size={16}
                          className={
                            groupCollapsed
                              ? '-rotate-90 transition-transform'
                              : 'transition-transform'
                          }
                        />
                      </button>
                      {/* Clicking the company name selects everyone in it. That is
                          the operation an administrator actually performs on a
                          company; jumping to a filtered URL stayed available in
                          the menu next to it. */}
                      <button
                        type="button"
                        aria-pressed={groupFullySelected}
                        title={
                          groupFullySelected
                            ? 'Снять выделение с компании'
                            : 'Выбрать всех сотрудников этой компании'
                        }
                        onClick={() =>
                          void setOrganizationGroupSelected(row.organization, !groupFullySelected)
                        }
                        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left hover:bg-[var(--color-surface)]"
                      >
                        <span
                          aria-hidden
                          className={`grid size-4 shrink-0 place-items-center rounded-[4px] border text-[10px] leading-none ${
                            groupFullySelected
                              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white'
                              : 'border-[var(--color-border-strong)]'
                          }`}
                        >
                          {groupFullySelected ? '✓' : ''}
                        </span>
                        <span className="min-w-0 break-words">
                          {row.organization || 'Компания не указана'}
                        </span>
                        <span className="shrink-0 font-medium text-[var(--color-text-muted)] tabular-nums">
                          {row.organizationGroupCount}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-9"
                            aria-label={`Действия с компанией: ${row.organization || 'не указана'}`}
                          >
                            <DotsThree size={18} weight="bold" />
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
                          <DropdownMenuItem
                            onSelect={() => {
                              void setOrganizationGroupSelected(row.organization, true);
                              setPending({ kind: 'bulk-update', field: 'organization' });
                            }}
                          >
                            Изменить название компании
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
                  <AttestationTableRow
                    row={row}
                    selected={selected.has(row.recordId)}
                    onSelectChange={(checked) => setRowSelected(row, checked)}
                    onOpenDetails={() => setDetail(row)}
                    permissions={permissions}
                    onSingleAction={(action) => openSingleAction(row, action)}
                    organizationHref={(org) => organizationHref(filters, org)}
                    grouped={grouped}
                  />
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
            className="glass-strong sticky bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+.5rem)] z-30 flex items-center gap-3 rounded-2xl border p-3 shadow-[var(--shadow-pop)] @min-[760px]:hidden"
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
            className="glass-strong sticky bottom-4 z-30 hidden rounded-2xl border p-4 shadow-[var(--shadow-pop)] @min-[760px]:block"
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
              className="fixed inset-0 z-50 grid items-end bg-black/45 @min-[760px]:hidden"
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
