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
} from '@/lib/admin/types';
import { ADMIN_PURGE_BULK_LIMIT } from '@/lib/constants';
import { ADMIN_ATTESTATION_BULK_LIMIT } from '@/lib/constants';
import { AdminOverlay } from '@/components/admin/admin-overlay';
import { clientRequest, clientRequestMessage, readClientResponseJson } from '@/lib/client-request';
import { organizationArchiveFilename } from '@/lib/pdf/certificate-export-groups';
import {
  assertCertificateExportMetadata,
  type CertificateExportMetadata,
} from '@/lib/pdf/certificate-client-contract';
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
  attestationFieldMaxLengths,
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

/**
 * Machine skip codes from the database, in the words an operator can act on.
 *
 * The previous mapping collapsed every code into one of four vague phrases, and
 * "состояние изменилось" swallowed the two codes that actually explain a failed
 * reissue. An unrecognised code is now shown verbatim instead of being hidden.
 */
const SKIP_REASON_LABELS: Record<string, string> = {
  IDENTITY_NOT_VERIFIED: 'данные сотрудника не подтверждены',
  ATTESTATION_NOT_ELIGIBLE: 'тест не сдан на проходной балл',
  ATTESTATION_NOT_FOUND: 'результат теста больше не существует',
  ACCOUNT_UNAVAILABLE: 'аккаунт недоступен',
  ACTIVE_CERTIFICATE_EXISTS: 'действующий сертификат уже выдан',
  CERTIFICATE_LOCALIZATION_NOT_FOUND: 'нет версии курса на языке теста — переопубликуйте курс',
  CERTIFICATE_NOT_FOUND: 'сертификат не найден',
  ACCOUNT_SUSPENDED: 'аккаунт заблокирован',
  ACCOUNT_DELETION_REQUESTED: 'помечен на удаление',
  CANNOT_DELETE_SELF: 'нельзя удалить собственный аккаунт',
  ACCOUNT_HAS_PENDING_AUTH_OPERATIONS: 'идёт служебная операция — повторите через минуту',
  LAST_ACTIVE_SUPERADMIN_PROTECTED: 'нельзя удалить последнего администратора',
  OPERATION_SKIPPED: 'состояние строки изменилось до выполнения',
};

function skipReasonLabel(code: string | null | undefined) {
  if (!code) return SKIP_REASON_LABELS.OPERATION_SKIPPED as string;
  return SKIP_REASON_LABELS[code] ?? `код ${code}`;
}

function organizationGroupKey(value: string) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('ru-RU');
}

function unique(values: string[]) {
  return [...new Set(values)];
}

/** Server-resolved selections are kept one per company band (or `'*'` for the
 * whole filter), so a second company adds to the first instead of replacing it. */
const ALL_FILTERED_KEY = '*';

type ResolvedSelectionEntry = {
  key: string;
  label: string;
  selection: AdminAttestationSelection;
};

function unionAttestationSelections(list: AdminAttestationSelection[]): AdminAttestationSelection {
  const [first] = list;
  if (list.length === 1 && first) return first;
  const recordIds = unique(list.flatMap((selection) => selection.recordIds));
  const userIds = unique(list.flatMap((selection) => selection.userIds));
  const sum = (pick: (selection: AdminAttestationSelection) => number) =>
    list.reduce((total, selection) => total + pick(selection), 0);
  // Bands are disjoint by company key, so the counters add up exactly.
  return {
    recordIds,
    attestationIds: unique(list.flatMap((selection) => selection.attestationIds)),
    userIds,
    certificateIds: unique(list.flatMap((selection) => selection.certificateIds)),
    total: recordIds.length,
    uniquePeople: userIds.length,
    pendingIdentity: sum((selection) => selection.pendingIdentity),
    ready: sum((selection) => selection.ready),
    issued: sum((selection) => selection.issued),
    exportable: sum((selection) => selection.exportable),
  };
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
  const warnings: Array<{
    primary: string;
    primaryCount: number;
    typo: string;
    typoCount: number;
  }> = [];

  // Normalized once per company rather than once per pair: with 500 selected
  // rows the inner loop repeated the same lowercasing and regex a quarter of a
  // million times, and it runs while the operator waits for the dialog.
  const normalized = orgs.map((org) => org.toLowerCase().replace(/[\s\-_"«»]/g, ''));

  for (let i = 0; i < orgs.length; i++) {
    const a = orgs[i];
    if (!a) continue;
    for (let j = i + 1; j < orgs.length; j++) {
      const b = orgs[j];
      if (!b) continue;
      const normA = normalized[i] ?? '';
      const normB = normalized[j] ?? '';
      if (
        normA !== normB &&
        (normA.includes(normB) || normB.includes(normA) || levenshteinDistance(normA, normB) <= 2)
      ) {
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
  const [resolvedSelections, setResolvedSelections] = useState<ResolvedSelectionEntry[]>([]);
  const resolvedSelection = useMemo(
    () =>
      resolvedSelections.length === 0
        ? null
        : unionAttestationSelections(resolvedSelections.map((entry) => entry.selection)),
    [resolvedSelections],
  );
  const allFilteredSelected = resolvedSelections.some((entry) => entry.key === ALL_FILTERED_KEY);
  const [selectingAll, setSelectingAll] = useState(false);
  const [pending, setPending] = useState<AttestationPendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [messageReasons, setMessageReasons] = useState<Array<[string, number]>>([]);
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
  const purgeKeysRef = useRef<string[]>([]);
  const purgeSignatureRef = useRef('');
  const exportAbortRef = useRef<AbortController | null>(null);
  const selectionRequestRef = useRef(0);
  const selectionAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    setClientReady(true);
  }, []);
  useEffect(
    () => () => {
      // Leaving the page must stop the work it started: the certificate worker
      // keeps rendering PDFs otherwise, and finishes by starting a download on
      // a screen the operator has already left.
      exportAbortRef.current?.abort();
      exportAbortRef.current = null;
      selectionAbortRef.current?.abort();
      selectionAbortRef.current = null;
    },
    [],
  );
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
  const rowIdsByGroup = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const item of page.items) {
      const key = organizationGroupKey(item.organization);
      const ids = groups.get(key);
      if (ids) ids.push(item.recordId);
      else groups.set(key, [item.recordId]);
    }
    return groups;
  }, [page.items]);
  const selectedCount = resolvedSelection?.total ?? selected.size;
  // A row whose course was deleted still belongs to a real person, and deleting
  // that person is exactly what an operator expects the checkbox to cover.
  const userIds = resolvedSelection?.userIds ?? unique(selectedRows.map((row) => row.userId));
  const recordIds = resolvedSelection?.recordIds ?? selectedRows.map((row) => row.recordId);
  const attestationIds =
    resolvedSelection?.attestationIds ??
    selectedRows.flatMap((row) => (row.attestationId ? [row.attestationId] : []));
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

  // How many company archives an export would produce; null when the server
  // aggregate ("all rows by filter") cannot say.
  const exportCompanies = useMemo<number | null>(() => {
    if (allFilteredSelected) return filters.organization ? 1 : null;
    const keys = new Set<string>();
    for (const entry of resolvedSelections) {
      if (entry.selection.exportable > 0) keys.add(entry.key);
    }
    for (const row of selectedRows) {
      if (row.certificateState === 'issued' && Boolean(row.certificateId)) {
        keys.add(organizationGroupKey(row.organization));
      }
    }
    return keys.size;
  }, [allFilteredSelected, filters.organization, resolvedSelections, selectedRows]);

  const setRowSelected = (row: AdminAttestationRow, checked: boolean) => {
    // "All rows matching the filter" arrives from the server as aggregates and
    // cannot be narrowed here, so touching one checkbox drops it entirely.
    // Silently, this turned «Выбрано: 480» into the size of one page.
    // A company band is narrowed the same way, but only that company's band.
    const rowKey = organizationGroupKey(row.organization);
    const rowEntry = resolvedSelections.find((entry) => entry.key === rowKey);
    if (allFilteredSelected && resolvedSelection) {
      setMessage(
        `Выборка по фильтру (${resolvedSelection.total}) снята: изменение одной строки оставляет только строки этой страницы.`,
      );
      setResolvedSelections([]);
    } else if (rowEntry) {
      setMessage(
        `Выборка компании «${rowEntry.label || 'не указана'}» (${rowEntry.selection.total}) снята: изменение одной строки оставляет только строки этой страницы.`,
      );
      setResolvedSelections((current) => current.filter((entry) => entry.key !== rowKey));
    }
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(row.recordId);
      else next.delete(row.recordId);
      return next;
    });
  };

  const dropResolvedSelection = (key: string) => {
    if (key === ALL_FILTERED_KEY) {
      setResolvedSelections([]);
      setSelected(new Set());
      return;
    }
    setResolvedSelections((current) =>
      current.filter((entry) => entry.key !== key && entry.key !== ALL_FILTERED_KEY),
    );
  };

  const resolveFilteredSelection = async (
    key: string,
    label: string,
    selectionFilters: FilterSnapshot,
    visibleIds: string[],
    successMessage: (selection: AdminAttestationSelection) => string,
  ) => {
    // Every resolution is numbered, and only the newest one may write state.
    // Without this the slower of two clicks won, and the row identifiers behind
    // "delete" belonged to a company the operator was no longer looking at.
    const requestId = selectionRequestRef.current + 1;
    selectionRequestRef.current = requestId;
    selectionAbortRef.current?.abort();
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    setSelectingAll(true);
    setMessage('Разрешаем выборку по фильтру…');
    // The stale entry for this key is cleared up front: showing the previous
    // count next to a new company's name is how the wrong rows get confirmed.
    // Other companies already selected stay.
    dropResolvedSelection(key);
    try {
      const result = await clientRequest(
        '/api/admin/attestations/selection',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(selectionFilters),
        },
        { signal: controller.signal },
      );
      if (requestId !== selectionRequestRef.current) return null;
      const payload = await readClientResponseJson<AdminAttestationSelection | { error?: string }>(
        result.response,
      );
      if (requestId !== selectionRequestRef.current) return null;
      if (!result.ok || !payload || !('attestationIds' in payload)) {
        // The server answers 409 when the filter matches more rows than one
        // operation may carry; that is an instruction to narrow the filter, not
        // a failure to report as a server fault.
        const tooLarge =
          payload && 'error' in payload && payload.error === 'ATTESTATION_SELECTION_TOO_LARGE';
        setMessage(
          tooLarge
            ? `Под фильтр попало больше ${ADMIN_ATTESTATION_BULK_LIMIT} строк. Уточните фильтр и повторите.`
            : result.ok
              ? 'Сервер вернул неполный список.'
              : clientRequestMessage(result.error, 'Не удалось выбрать строки по фильтру.'),
        );
        return null;
      }
      const others = resolvedSelections.filter(
        (entry) => entry.key !== key && entry.key !== ALL_FILTERED_KEY,
      );
      const combinedTotal =
        others.reduce((total, entry) => total + entry.selection.total, 0) + payload.total;
      if (key !== ALL_FILTERED_KEY && combinedTotal > ADMIN_ATTESTATION_BULK_LIMIT) {
        setMessage(
          `Вместе с «${label || 'не указана'}» выборка превысит ${ADMIN_ATTESTATION_BULK_LIMIT} строк. Снимите часть компаний.`,
        );
        return null;
      }
      setResolvedSelections(
        key === ALL_FILTERED_KEY
          ? [{ key, label, selection: payload }]
          : [...others, { key, label, selection: payload }],
      );
      setSelected((current) =>
        key === ALL_FILTERED_KEY ? new Set(visibleIds) : new Set([...current, ...visibleIds]),
      );
      setMessage(successMessage(payload));
      return payload;
    } catch (requestError) {
      if (requestId !== selectionRequestRef.current) return null;
      setMessage(clientRequestMessage(requestError, 'Не удалось выбрать строки по фильтру.'));
      return null;
    } finally {
      if (requestId === selectionRequestRef.current) setSelectingAll(false);
    }
  };

  const setOrganizationGroupSelected = async (
    organization: string,
    checked: boolean,
    mode: 'add' | 'replace' = 'add',
  ) => {
    const key = organizationGroupKey(organization);
    if (!checked) {
      // Unticking one company must not wipe an unrelated selection. A resolved
      // "all filtered rows" selection is server-side and cannot be narrowed, so
      // that one is still dropped whole; a company band drops only itself.
      if (allFilteredSelected) {
        clearSelection();
        return;
      }
      setResolvedSelections((current) => current.filter((entry) => entry.key !== key));
      setSelected((current) => {
        const next = new Set(current);
        for (const item of page.items) {
          if (organizationGroupKey(item.organization) === key) next.delete(item.recordId);
        }
        return next;
      });
      return;
    }
    // Companies accumulate, so a mixed export can leave the browser as one
    // archive per company. Renaming a company is the one action that must
    // never spill over into other selected companies, hence `replace`.
    if (mode === 'replace') {
      setResolvedSelections([]);
      setSelected(new Set());
    }
    const groupRows = page.items.filter((row) => organizationGroupKey(row.organization) === key);
    return resolveFilteredSelection(
      key,
      organization,
      { ...filters, organization },
      groupRows.map((row) => row.recordId),
      () => '',
    );
  };

  const selectAllFiltered = async () => {
    if (page.total > ADMIN_ATTESTATION_BULK_LIMIT) {
      setMessage(
        `За один раз можно обработать не более ${ADMIN_ATTESTATION_BULK_LIMIT} строк. Уточните фильтр.`,
      );
      return;
    }
    await resolveFilteredSelection(
      ALL_FILTERED_KEY,
      '',
      filters,
      page.items.map((row) => row.recordId),
      () => '',
    );
  };

  const clearSelection = () => {
    setSelected(new Set());
    setResolvedSelections([]);
    setMessage('');
    setMessageReasons([]);
    setBulkActionsOpen(false);
  };

  const openSingleAction = (row: AdminAttestationRow, action: AttestationPendingAction) => {
    if (action.kind === 'confirm-issue') {
      void runConfirmIssueDirect(row);
      return;
    }
    setSelected(new Set([row.recordId]));
    setResolvedSelections([]);
    setPending(action);
    setError('');
    setBulkActionsOpen(false);
  };

  const dialogConfig = useMemo<AttestationDialogConfig | null>(() => {
    if (!pending) return null;
    if (pending.kind === 'confirm') {
      return {
        title: 'Подтвердить данные',
        description: `Будут подтверждены данные: ${selectionSummary.pendingIdentity} чел.`,
        confirmLabel: `Подтвердить ${selectionSummary.pendingIdentity}`,
      };
    }
    if (pending.kind === 'confirm-issue') {
      return {
        title: 'Подтвердить и выдать',
        description: `Данные будут подтверждены, сертификаты выданы: ${selectionSummary.total}.`,
        confirmLabel: `Подтвердить и выдать ${selectionSummary.total}`,
      };
    }
    if (pending.kind === 'bulk-update') {
      return {
        title: `Изменить поле «${attestationFieldLabels[pending.field]}»`,
        description: `Значение применится к ${selectionSummary.people} чел.; действующие сертификаты перевыпускаются.`,
        confirmLabel: 'Сохранить изменение',
        input: {
          label: `Новое значение: ${attestationFieldLabels[pending.field]}`,
          maxLength: attestationFieldMaxLengths[pending.field],
        },
      };
    }
    if (pending.kind === 'issue') {
      const typoWarnings = findCompanyTypoWarnings(selectedRows);
      const firstWarning = typoWarnings[0];
      const warningText = firstWarning
        ? ` ⚠️ Похожие компании: «${firstWarning.primary}» и «${firstWarning.typo}» — проверьте перед выдачей.`
        : '';
      return {
        title: 'Выдать сертификаты',
        description: `Выдача: ${selectionSummary.readyToIssue} из ${selectionSummary.total} выбранных.${warningText}`,
        confirmLabel: `Выдать ${selectionSummary.readyToIssue}`,
      };
    }
    if (pending.kind === 'bulk-delete') {
      return {
        title: 'Удалить сотрудников',
        description: `Будет удалено человек: ${selectionSummary.people}. Аккаунт, попытки и сертификаты удаляются безвозвратно.`,
        confirmLabel: `Удалить ${selectionSummary.people} чел.`,
        tone: 'danger',
        reason: {
          label: 'Причина удаления (останется в истории действий)',
          minLength: 10,
          placeholder: 'Например: уволен, данные удалены по заявлению',
        },
        confirmationPhrase:
          selectionSummary.people >= 5 ? `УДАЛИТЬ ${selectionSummary.people}` : undefined,
      };
    }
    const companies = exportCompanies;
    return {
      title: 'Скачать пакет документов',
      description:
        companies === null
          ? `Сертификатов: ${selectionSummary.exportable} из ${selectionSummary.total}. Архивы формируются по одному на компанию, в каждом — сертификаты и сводный отчёт.`
          : companies > 1
            ? `Сертификатов: ${selectionSummary.exportable} из ${selectionSummary.total}. Будет сформировано ${companies} ZIP — по одному на компанию, в каждом свой сводный отчёт. Браузер может запросить разрешение на скачивание нескольких файлов.`
            : `Сертификатов в ZIP: ${selectionSummary.exportable} из ${selectionSummary.total} + сводный отчёт.`,
      confirmLabel:
        companies !== null && companies > 1 ? `Сформировать ${companies} ZIP` : 'Сформировать ZIP',
    };
  }, [exportCompanies, pending, selectedRows, selectionSummary]);

  const mutationSummary = (
    items: AdminAttestationMutationItem[],
    kind: AttestationPendingAction['kind'],
  ) => {
    const completed = items.filter((item) => item.status === 'completed').length;
    const already = items.filter((item) => item.status === 'already_completed').length;
    const skipped = items.filter((item) => item.status === 'skipped');
    const actionLabel = {
      confirm: 'Данные подтверждены',
      'confirm-issue': 'Данные подтверждены, сертификаты выданы',
      'bulk-update': 'Данные обновлены',
      issue: 'Сертификаты выданы',
      export: 'Архив сформирован',
      'bulk-delete': 'Сотрудники удалены',
    }[kind];
    const reasons = skipped.reduce<Record<string, number>>((result, item) => {
      const label = skipReasonLabel(item.reason);
      result[label] = (result[label] ?? 0) + 1;
      return result;
    }, {});
    const headline = `${actionLabel}: ${completed}.${already > 0 ? ` Уже были в нужном состоянии: ${already}.` : ''}${
      skipped.length > 0 ? ` Пропущено: ${skipped.length}.` : ''
    }`;
    return { headline, reasons: Object.entries(reasons) };
  };

  /**
   * Deletes every selected person in as few requests as the endpoint allows.
   *
   * The previous implementation sent one DELETE per person. The `admin.delete`
   * quota is 10 requests per five minutes, so from the eleventh person on every
   * request came back 429 and the panel reported them as nameless "Ошибок: N"
   * while claiming the rest had been deleted.
   */
  const purgeSelectedUsers = async (reason: string) => {
    if (userIds.length === 0) return;
    setBusy(true);
    setError('');
    const chunks: string[][] = [];
    for (let offset = 0; offset < userIds.length; offset += ADMIN_PURGE_BULK_LIMIT) {
      chunks.push(userIds.slice(offset, offset + ADMIN_PURGE_BULK_LIMIT));
    }
    // One stable key per chunk, so a retry of the same click replays instead of
    // deleting twice. The keys are tied to what they authorize: the database
    // refuses a key replayed with a different request, so keying only on the
    // chunk count meant that editing the reason and pressing delete again hit
    // IDEMPOTENCY_KEY_REUSED forever, with no way out but a page reload.
    const purgeSignature = `${reason}::${userIds.join(',')}`;
    if (purgeSignatureRef.current !== purgeSignature) {
      purgeSignatureRef.current = purgeSignature;
      purgeKeysRef.current = chunks.map(() => crypto.randomUUID());
    }
    const items: AdminAttestationMutationItem[] = [];
    try {
      for (const [index, chunk] of chunks.entries()) {
        const result = await clientRequest(
          '/api/admin/users/purge',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds: chunk,
              reason,
              confirmation: 'УДАЛИТЬ',
              idempotencyKey: purgeKeysRef.current[index],
            }),
          },
          { timeoutMs: 120_000 },
        );
        const payload = await readClientResponseJson<{
          error?: string;
          items?: AdminAttestationMutationItem[];
        }>(result.response);
        if (!result.ok || !payload?.items) {
          if (payload?.error === 'IDEMPOTENCY_KEY_REUSED') {
            // The keys no longer match what is being asked for. Dropping them
            // lets the next attempt through instead of repeating forever.
            purgeKeysRef.current = [];
            purgeSignatureRef.current = '';
          }
          const fallback =
            payload?.error === 'LAST_ACTIVE_ADMIN_PROTECTED'
              ? 'Нельзя удалить последнего администратора.'
              : payload?.error === 'CANNOT_DELETE_SELF'
                ? 'Нельзя удалить собственный аккаунт.'
                : payload?.error === 'IDEMPOTENCY_KEY_REUSED'
                  ? 'Запрос изменился. Нажмите «Удалить» ещё раз.'
                  : 'Удаление не выполнено. Обновите страницу и проверьте список.';
          setError(result.ok ? fallback : clientRequestMessage(result.error, fallback));
          if (items.length > 0) {
            // Earlier chunks already deleted people. Reporting "nothing
            // happened" and leaving the list untouched made the operator delete
            // them a second time.
            const partial = mutationSummary(items, 'bulk-delete');
            setMessage(
              `${partial.headline} Обработано пачек: ${index} из ${chunks.length}. Выделение сохранено — повторите удаление, чтобы завершить остальные.`,
            );
            setMessageReasons(partial.reasons);
            setDetail(null);
            router.refresh();
          }
          return;
        }
        items.push(...payload.items);
      }
      const summary = mutationSummary(items, 'bulk-delete');
      purgeKeysRef.current = [];
      purgeSignatureRef.current = '';
      setPending(null);
      setDetail(null);
      clearSelection();
      setMessage(summary.headline);
      setMessageReasons(summary.reasons);
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Удаление не выполнено.'));
    } finally {
      setBusy(false);
    }
  };

  const runAttestationAction = async (
    body: Record<string, unknown>,
    actionKind: AttestationPendingAction['kind'],
  ) => {
    setBusy(true);
    setError('');
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
      setMessage(summary.headline);
      setMessageReasons(summary.reasons);
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Операция не выполнена.'));
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async ({ value, reason }: { value: string; reason: string }) => {
    if (!pending) return;
    if (pending.kind === 'export') {
      setPending(null);
      await downloadZip();
      return;
    }
    if (pending.kind === 'bulk-delete') {
      await purgeSelectedUsers(reason);
      return;
    }
    const idempotencyKey = idempotencyKeyRef.current || crypto.randomUUID();
    idempotencyKeyRef.current = idempotencyKey;
    const body =
      pending.kind === 'confirm'
        ? { action: 'confirm', userIds, idempotencyKey }
        : pending.kind === 'confirm-issue'
          ? { action: 'confirm_and_issue', attestationIds, idempotencyKey }
          : pending.kind === 'bulk-update'
            ? { action: 'update', userIds, field: pending.field, value, idempotencyKey }
            : { action: 'issue', attestationIds, idempotencyKey };
    await runAttestationAction(body, pending.kind);
  };

  // Single-row "confirm + issue" has no inputs, so it skips the dialog entirely.
  const runConfirmIssueDirect = async (row: AdminAttestationRow) => {
    if (!row.attestationId) return;
    setSelected(new Set([row.recordId]));
    setResolvedSelections([]);
    setPending(null);
    setDetail(null);
    setBulkActionsOpen(false);
    await runAttestationAction(
      {
        action: 'confirm_and_issue',
        attestationIds: [row.attestationId],
        idempotencyKey: crypto.randomUUID(),
      },
      'confirm-issue',
    );
  };

  const downloadZip = async () => {
    if (recordIds.length === 0) return;
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setBusy(true);
    setExportProgress({ completed: 0, total: selectionSummary.exportable });
    setMessage('Получаем данные сертификатов. PDF и ZIP будут сформированы только в браузере…');
    try {
      // The renderer bridge and the archive writer load only once an export
      // starts; no other admin screen needs them in its first paint.
      const { downloadCertificateExportInBrowser, requestCertificateArchiveFileHandle } =
        await import('@/lib/pdf/certificate-client');
      // `showSaveFilePicker` creates the .zip on disk before a single
      // certificate is rendered, so any later failure leaves a 0-byte file that
      // Windows reports as a damaged archive. Small exports therefore stay on
      // the buffered path, which only ever hands over a finished blob. So do
      // exports spanning several companies: each company gets its own archive,
      // and the picker can name only one file per click.
      const multiCompany = exportCompanies === null || exportCompanies > 1;
      const [onlyEntry] = resolvedSelections;
      const singleCompany =
        resolvedSelections.length === 1 && onlyEntry && onlyEntry.key !== ALL_FILTERED_KEY
          ? onlyEntry.label
          : filters.organization;
      const fileHandle =
        recordIds.length > 100 && !multiCompany
          ? await requestCertificateArchiveFileHandle(
              organizationArchiveFilename(singleCompany) ??
                `safetyhub-certificates-${new Date().toISOString().slice(0, 10)}.zip`,
            )
          : null;
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
          setMessage(
            clientRequestMessage(metadataResult.error, 'Не удалось получить данные экспорта.'),
          );
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
          setMessage(
            clientRequestMessage(metadataResult.error, 'Не удалось получить данные экспорта.'),
          );
          return;
        }
        metadataResponse = metadataResult.response;
      }
      const metadata = await readClientResponseJson<CertificateExportMetadata>(metadataResponse);
      assertCertificateExportMetadata(metadata);
      const result = await downloadCertificateExportInBrowser(metadata, {
        fileHandle,
        groupBy: 'organization',
        signal: controller.signal,
        onProgress: (progress) => {
          setExportProgress(progress);
          setMessage(
            `Формируем сертификаты в браузере: ${progress.completed} из ${progress.total}…`,
          );
        },
      });
      const skippedNote =
        metadata.skipped.length > 0
          ? ` Без действующего сертификата: ${metadata.skipped.length}.`
          : '';
      setMessage(
        result.streamed
          ? `ZIP сформирован в браузере и записан в выбранный файл.${skippedNote}`
          : result.companies > 1
            ? `Сформировано ${result.archives} ZIP по ${result.companies} компаниям и передано на скачивание.${skippedNote}`
            : `ZIP сформирован в браузере и передан на скачивание${result.archives > 1 ? ` (${result.archives} частей по 100 сертификатов максимум)` : ''}.${skippedNote}`,
      );
    } catch (requestError) {
      if (
        controller.signal.aborted ||
        (requestError instanceof DOMException && requestError.name === 'AbortError')
      ) {
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
      // The bottom reserve is constant: making it appear only while something is
      // selected made the whole page jump on the first tick of a checkbox.
      className="space-y-3 pb-28 @min-[760px]:pb-36"
    >
      <AttestationSelectionBanner
        selectedCount={selectedCount}
        totalFiltered={page.total}
        pageSize={page.items.length}
        isAllFilteredSelected={allFilteredSelected}
        selectingAll={selectingAll}
        onSelectAllFiltered={selectAllFiltered}
        onClearSelection={clearSelection}
      />

      {message ? (
        <div role="status" className="rounded-xl bg-[var(--color-primary-soft)] px-4 py-3 text-sm">
          <p>{message}</p>
          {messageReasons.length > 0 ? (
            <>
              <p className="mt-2 font-bold">Почему пропущено:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {messageReasons.map(([label, count]) => (
                  <li key={label}>
                    {count} — {label}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
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
          className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-20 hidden min-h-9 items-center gap-x-2 bg-[var(--color-surface-muted)] px-1.5 text-left text-xs font-bold text-[var(--color-text-muted)] shadow-[0_1px_var(--color-border)] min-[1024px]:top-0 @min-[760px]:grid @min-[760px]:grid-cols-[32px_minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(0,1.25fr)_6.5rem_44px_minmax(0,0.9fr)_44px]"
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

        <div role="rowgroup" className="space-y-2 @min-[760px]:space-y-0">
          {page.items.map((row, index) => {
            const groupKey = organizationGroupKey(row.organization);
            const showGroup =
              grouped &&
              (index === 0 ||
                groupKey !== organizationGroupKey(page.items[index - 1]?.organization ?? ''));
            const groupCollapsed = collapsedGroups.has(groupKey);
            const groupRowIds = showGroup ? (rowIdsByGroup.get(groupKey) ?? []) : [];
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
                        className="grid size-11 shrink-0 place-items-center rounded-lg hover:bg-[var(--color-surface)] @min-[760px]:size-9"
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
                        disabled={selectingAll || busy}
                        onClick={() =>
                          void setOrganizationGroupSelected(row.organization, !groupFullySelected)
                        }
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 text-left hover:bg-[var(--color-surface)] @min-[760px]:min-h-9"
                      >
                        <span
                          aria-hidden
                          className={`grid size-4 shrink-0 place-items-center rounded-[4px] border text-[10px] leading-none ${
                            groupFullySelected
                              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                              : 'border-[var(--color-border-strong)]'
                          }`}
                        >
                          {groupFullySelected ? '✓' : ''}
                        </span>
                        <span className="min-w-0 text-base font-bold break-words @min-[760px]:text-sm @min-[760px]:font-semibold">
                          {row.organization || 'Компания не указана'}
                        </span>
                        <span className="shrink-0 text-sm font-medium text-[var(--color-text-muted)] tabular-nums">
                          {row.organizationGroupCount}
                        </span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-11 @min-[760px]:size-9"
                            aria-label={`Действия с компанией: ${row.organization || 'не указана'}`}
                          >
                            <DotsThree size={18} weight="bold" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            disabled={selectingAll || busy}
                            onSelect={() =>
                              void setOrganizationGroupSelected(row.organization, true)
                            }
                          >
                            Выбрать всю компанию
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={selectingAll || busy}
                            onSelect={() => {
                              // The dialog used to open before the selection had
                              // resolved: it reported "0 чел." and the request
                              // behind it was refused as INVALID_REQUEST.
                              void (async () => {
                                const selection = await setOrganizationGroupSelected(
                                  row.organization,
                                  true,
                                  'replace',
                                );
                                if (!selection) return;
                                setPending({ kind: 'bulk-update', field: 'organization' });
                              })();
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
            <p className="min-w-0 flex-1 font-bold tabular-nums">Выбрано: {selectedCount}</p>
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
            className="glass-strong sticky bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+1rem)] z-[var(--z-sticky)] hidden rounded-2xl border p-4 shadow-[var(--shadow-pop)] min-[1024px]:bottom-4 @min-[760px]:block"
          >
            <div className="flex flex-wrap items-center gap-3">
              <strong className="text-sm tabular-nums">Выбрано: {selectionSummary.total}</strong>
              <AttestationBulkActionButtons
                summary={selectionSummary}
                permissions={permissions}
                busy={busy}
                onAction={setPending}
              />
            </div>
          </aside>

          {bulkActionsOpen ? (
            <AdminOverlay>
              <div
                className="fixed inset-0 z-[var(--z-overlay)] grid items-end bg-black/45 @min-[760px]:hidden"
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
                  <AttestationBulkActionButtons
                    summary={selectionSummary}
                    permissions={permissions}
                    busy={busy}
                    onAction={(action) => {
                      setBulkActionsOpen(false);
                      setPending(action);
                    }}
                    compact
                  />
                </section>
              </div>
            </AdminOverlay>
          ) : null}
        </>
      ) : null}

      <AttestationDetailDrawer
        row={detail}
        permissions={permissions}
        onAction={(row, action) => openSingleAction(row, action)}
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
