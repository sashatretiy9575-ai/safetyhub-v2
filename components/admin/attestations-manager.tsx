'use client';

import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { attestationNeedsIssuance } from '@/lib/admin/attestation-issuance';
import { CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { X } from '@phosphor-icons/react/dist/csr/X';
import type {
  AdminAttestationPage,
  AdminAttestationRow,
  AdminAttestationSelection,
  AdminAttestationMutationItem,
} from '@/lib/admin/types';
import { ADMIN_PURGE_BULK_LIMIT } from '@/lib/constants';
import { ADMIN_ATTESTATION_BULK_LIMIT } from '@/lib/constants';
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
import { AttestationSelectionBanner } from './attestation-selection-banner';
import { AttestationTableRow } from './attestation-table-row';
import {
  AttestationBulkActionButtons,
  AttestationDetailDrawer,
  attestationFieldLabels,
  attestationFieldMaxLengths,
  preloadAttestationCard,
  type AttestationCardIssue,
  type AttestationIdentityDraft,
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
  'DOCUMENT_REQUIRED_FIELDS:education': 'заполните образование сотрудника перед новой выдачей',
  DOCUMENT_PROFILE_REQUIRED: 'выберите категорию слушателей в редакторе документов',
  DOCUMENT_FORMAL_EXAM_REQUIRED:
    'для промбеза внесите подтверждённые реквизиты отдельного экзамена: протокол, дата и положительный результат; учебного теста недостаточно',
  'DOCUMENT_REQUIRED_FIELDS:orderNumber,orderDate,verificationKind':
    'заполните номер и дату приказа, вид проверки в профиле БиОТ',
  'DOCUMENT_REQUIRED_FIELDS:trainingReason': 'укажите причину обучения участника в протоколе ПТМ',
  'DOCUMENT_REQUIRED_FIELDS:qualificationDecision':
    'внесите решение квалификационной комиссии для участника',
  'DOCUMENT_REQUIRED_FIELDS:organization,position': 'заполните организацию и должность сотрудника',
  DOCUMENT_SIGNER_ASSET_MISMATCH:
    'подпись не соответствует члену комиссии — проверьте профиль документа',
};

function skipReasonLabel(code: string | null | undefined) {
  if (!code) return SKIP_REASON_LABELS.OPERATION_SKIPPED as string;
  return SKIP_REASON_LABELS[code] ?? `код ${code}`;
}

/** The document profile's names for the fields the person's card can edit. */
const CARD_ISSUE_FIELDS: Record<string, AttestationCardIssue['fields'][number]> = {
  organization: 'organization',
  position: 'job',
  education: 'education',
};

/** Which of the card's own fields a refused issuance asks for, if any. */
function cardIssueFields(reason: string | null | undefined): AttestationCardIssue['fields'] {
  const prefix = 'DOCUMENT_REQUIRED_FIELDS:';
  if (!reason?.startsWith(prefix)) return [];
  return reason
    .slice(prefix.length)
    .split(',')
    .flatMap((name) => CARD_ISSUE_FIELDS[name] ?? []);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The open card lives in the address as `?card=<recordId>`, so a reload lands
 * on the same person. `replaceState`, not `router.replace`: nothing on the
 * server reads the parameter, and opening a card must not fetch the list again.
 * Filter and pagination links are built without it, which is what closes the
 * card when the list under it changes.
 */
function writeCardParam(recordId: string | null) {
  const url = new URL(window.location.href);
  if (recordId) url.searchParams.set('card', recordId);
  else url.searchParams.delete('card');
  if (url.href === window.location.href) return;
  // A null state: Next.js copies its own router state into the entry.
  window.history.replaceState(null, '', url);
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
  const [selectionRefreshFailed, setSelectionRefreshFailed] = useState(false);
  const [pending, setPending] = useState<AttestationPendingAction | null>(null);
  const [singleTarget, setSingleTarget] = useState<AdminAttestationRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [messageReasons, setMessageReasons] = useState<Array<[string, number]>>([]);
  const [exportProgress, setExportProgress] = useState<{ completed: number; total: number } | null>(
    null,
  );
  const [detail, setDetail] = useState<AdminAttestationRow | null>(null);
  const [detailIssue, setDetailIssue] = useState<AttestationCardIssue | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const idempotencyKeyRef = useRef('');
  const purgeKeysRef = useRef<string[]>([]);
  const purgeSignatureRef = useRef('');
  const exportAbortRef = useRef<AbortController | null>(null);
  const selectionRequestRef = useRef(0);
  const selectionAbortRef = useRef<AbortController | null>(null);
  const dirtySelectionKeysRef = useRef(new Set<string>());
  // `busy` is state: it disables the buttons one paint later, and both halves
  // of a double click arrive before that paint. This flag is read synchronously.
  const inFlightRef = useRef(false);
  // «Подтвердить и выдать» on one row has no dialog to hold its key, so the key
  // waits here until the server answers: a retry after a timeout replays it.
  const directKeysRef = useRef(new Map<string, string>());
  // Unsaved card edits, per row, in memory only: personal data is never put
  // into browser storage.
  const draftsRef = useRef(new Map<string, AttestationIdentityDraft>());
  const anchorRef = useRef<{ el: Element; top: number } | null>(null);
  const cardRestoredRef = useRef(false);
  // Which card is open when a request comes back, not when it was sent.
  const detailRef = useRef<AdminAttestationRow | null>(null);
  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);
  const canSeeCourses = permissions.canReadIdentity || permissions.canManageIdentity;
  useEffect(() => {
    setClientReady(true);
  }, []);
  useEffect(() => {
    if (!canSeeCourses) return;
    // The card's lazy chunk is fetched while the browser has nothing to do, so
    // the first card does not open on a download. Safari has no idle callback.
    if (typeof window.requestIdleCallback === 'function') {
      const idle = window.requestIdleCallback(preloadAttestationCard);
      return () => window.cancelIdleCallback(idle);
    }
    const timer = window.setTimeout(preloadAttestationCard, 1_500);
    return () => window.clearTimeout(timer);
  }, [canSeeCourses]);
  useEffect(() => {
    if (cardRestoredRef.current) return;
    cardRestoredRef.current = true;
    const recordId = new URLSearchParams(window.location.search).get('card');
    if (!recordId) return;
    const row = UUID_PATTERN.test(recordId)
      ? page.items.find((item) => item.recordId === recordId)
      : undefined;
    if (!row) {
      // Another page of the list, another filter, or not an identifier at all.
      writeCardParam(null);
      return;
    }
    // A native dialog hands focus back to whatever held it when it opened, so
    // the row's own button takes it first, as if it had been pressed.
    document
      .querySelector<HTMLElement>(`[data-card-trigger="${recordId}"]`)
      ?.focus({ preventScroll: true });
    setDetail(row);
  }, [page.items]);
  // `router.refresh()` brings new rows; the open card follows its own one, so
  // it shows what the server now holds instead of the row it was opened from.
  useEffect(() => {
    setDetail((current) =>
      current ? (page.items.find((row) => row.recordId === current.recordId) ?? current) : current,
    );
  }, [page.items]);
  // The panel above the list appears on the first tick and leaves on the last.
  // Where the browser's scroll anchoring has already kept the ticked row still
  // the difference is zero; at the top of the page, where anchoring does not
  // apply, and in Safari, which has none, the page is scrolled by that much.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;
    if (!anchor.el.isConnected) return;
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (delta) window.scrollBy(0, delta);
  });
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
      readyToIssue: selectedRows.filter(attestationNeedsIssuance).length,
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

  const setRowSelected = (row: AdminAttestationRow, checked: boolean, source?: Element) => {
    // Where the ticked box stands now; the layout effect above puts it back
    // there once the selection panel has pushed the list. The row passes its
    // checkbox because a tap does not focus it in Safari; anything outside a
    // row (the page body) would measure the scroll itself and undo it.
    const el = source ?? document.activeElement;
    anchorRef.current = el?.closest('[role="row"]')
      ? { el, top: el.getBoundingClientRect().top }
      : null;
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
    selectionRequestRef.current++;
    selectionAbortRef.current?.abort();
    setSelectingAll(false);
    setSelected(new Set());
    setResolvedSelections([]);
    dirtySelectionKeysRef.current.clear();
    setSelectionRefreshFailed(false);
    setMessage('');
    setMessageReasons([]);
  };

  const refreshResolvedSelections = async (affectedUserIds: readonly string[] = []) => {
    const snapshot = resolvedSelections.filter(
      (entry) =>
        dirtySelectionKeysRef.current.has(entry.key) ||
        affectedUserIds.some((id) => entry.selection.userIds.includes(id)),
    );
    if (!snapshot.length) {
      dirtySelectionKeysRef.current.clear();
      setSelectionRefreshFailed(false);
      return true;
    }
    snapshot.forEach((entry) => dirtySelectionKeysRef.current.add(entry.key));
    const requestId = ++selectionRequestRef.current;
    selectionAbortRef.current?.abort();
    const controller = new AbortController();
    selectionAbortRef.current = controller;
    setSelectingAll(true);
    try {
      const refreshed = await Promise.all(
        snapshot.map(async (entry) => {
          const result = await clientRequest(
            '/api/admin/attestations/selection',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ recordIds: entry.selection.recordIds }),
            },
            { signal: controller.signal },
          );
          const selection = await readClientResponseJson<AdminAttestationSelection>(
            result.response,
          );
          if (!result.ok || !selection || !Array.isArray(selection.recordIds))
            throw new Error('Не удалось обновить сводку выбранных сотрудников.');
          return { ...entry, selection };
        }),
      );
      if (requestId !== selectionRequestRef.current || controller.signal.aborted) return false;
      // Only replace the exact entries we requested; a later deselection must win.
      setResolvedSelections((current) =>
        current.flatMap((entry) => {
          const index = snapshot.indexOf(entry);
          if (index < 0) return [entry];
          const updated = refreshed[index]!;
          return updated.selection.recordIds.length ? [updated] : [];
        }),
      );
      const survivingIds = new Set(refreshed.flatMap((entry) => entry.selection.recordIds));
      const removedIds = new Set(
        snapshot
          .flatMap((entry) => entry.selection.recordIds)
          .filter((id) => !survivingIds.has(id)),
      );
      setSelected((current) => new Set([...current].filter((id) => !removedIds.has(id))));
      snapshot.forEach((entry) => dirtySelectionKeysRef.current.delete(entry.key));
      setSelectionRefreshFailed(dirtySelectionKeysRef.current.size > 0);
      return true;
    } catch {
      if (requestId === selectionRequestRef.current && !controller.signal.aborted)
        setSelectionRefreshFailed(true);
      return false;
    } finally {
      if (requestId === selectionRequestRef.current) setSelectingAll(false);
    }
  };

  const openDetail = (row: AdminAttestationRow) => {
    setDetail(row);
    setDetailIssue(null);
    // The card's footer shows the last refusal; it belonged to another person.
    setError('');
    writeCardParam(row.recordId);
  };

  const closeDetail = () => {
    setDetail(null);
    setDetailIssue(null);
    writeCardParam(null);
  };

  const openSingleAction = (row: AdminAttestationRow, action: AttestationPendingAction) => {
    if (busy) return;
    if (action.kind === 'confirm-issue') {
      void runConfirmIssueDirect(row);
      return;
    }
    setSingleTarget(row);
    setPending(action);
    setError('');
  };

  const actionSummary = useMemo<AttestationSelectionSummary>(
    () =>
      singleTarget
        ? {
            total: 1,
            people: 1,
            pendingIdentity: singleTarget.identityState === 'verified' ? 0 : 1,
            readyToIssue: attestationNeedsIssuance(singleTarget) ? 1 : 0,
            issued: singleTarget.certificateState === 'issued' ? 1 : 0,
            exportable:
              singleTarget.certificateId && singleTarget.certificateState === 'issued' ? 1 : 0,
          }
        : selectionSummary,
    [singleTarget, selectionSummary],
  );

  const pruneDeletedUser = async (userId: string) => {
    const removedIds = new Set(
      page.items.filter((row) => row.userId === userId).map((row) => row.recordId),
    );
    if (!resolvedSelections.some((entry) => entry.selection.userIds.includes(userId)))
      setSelected((current) => new Set([...current].filter((id) => !removedIds.has(id))));
    // Refresh the fixed selection so colleagues in the same company remain selected.
    await refreshResolvedSelections([userId]);
  };

  const dialogConfig = useMemo<AttestationDialogConfig | null>(() => {
    if (!pending) return null;
    if (pending.kind === 'confirm') {
      return {
        title: 'Подтвердить данные',
        description: `Будут подтверждены данные: ${actionSummary.pendingIdentity} чел.`,
        confirmLabel: `Подтвердить ${actionSummary.pendingIdentity}`,
      };
    }
    if (pending.kind === 'confirm-issue') {
      return {
        title: 'Подтвердить и выдать',
        description: `Данные будут подтверждены, сертификаты выданы: ${actionSummary.total}.`,
        confirmLabel: `Подтвердить и выдать ${actionSummary.total}`,
      };
    }
    if (pending.kind === 'bulk-update') {
      return {
        title: `Изменить поле «${attestationFieldLabels[pending.field]}»`,
        description: `Значение применится к ${actionSummary.people} чел.; действующие сертификаты перевыпускаются.`,
        confirmLabel: 'Сохранить изменение',
        input: {
          label: `Новое значение: ${attestationFieldLabels[pending.field]}`,
          maxLength: attestationFieldMaxLengths[pending.field],
        },
      };
    }
    if (pending.kind === 'issue') {
      const typoWarnings = findCompanyTypoWarnings(singleTarget ? [singleTarget] : selectedRows);
      const firstWarning = typoWarnings[0];
      const warningText = firstWarning
        ? ` ⚠️ Похожие компании: «${firstWarning.primary}» и «${firstWarning.typo}» — проверьте перед выдачей.`
        : '';
      return {
        title: 'Выдать сертификаты',
        description: `Выдача: ${actionSummary.readyToIssue} из ${actionSummary.total} выбранных.${warningText}`,
        confirmLabel: `Выдать ${actionSummary.readyToIssue}`,
      };
    }
    if (pending.kind === 'bulk-delete') {
      return {
        title: 'Удалить сотрудников',
        description: `Будет удалено человек: ${actionSummary.people}. Аккаунт, попытки и сертификаты удаляются безвозвратно.`,
        confirmLabel: `Удалить ${actionSummary.people} чел.`,
        tone: 'danger',
        reason: {
          label: 'Причина удаления (останется в истории действий)',
          minLength: 10,
          placeholder: 'Например: уволен, данные удалены по заявлению',
        },
        confirmationPhrase:
          actionSummary.people >= 5 ? `УДАЛИТЬ ${actionSummary.people}` : undefined,
      };
    }
    const companies = exportCompanies;
    return {
      title: 'Скачать пакет документов',
      description:
        companies === null
          ? `Сертификатов: ${actionSummary.exportable} из ${actionSummary.total}. Архивы формируются по одному на компанию, в каждом — сертификаты и сводный отчёт.`
          : companies > 1
            ? `Сертификатов: ${actionSummary.exportable} из ${actionSummary.total}. Будет сформировано ${companies} ZIP — по одному на компанию, в каждом свой сводный отчёт. Браузер может запросить разрешение на скачивание нескольких файлов.`
            : `Сертификатов в ZIP: ${actionSummary.exportable} из ${actionSummary.total} + сводный отчёт.`,
      confirmLabel:
        companies !== null && companies > 1 ? `Сформировать ${companies} ZIP` : 'Сформировать ZIP',
    };
  }, [exportCompanies, pending, selectedRows, actionSummary, singleTarget]);

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
    const targetUserIds = singleTarget ? [singleTarget.userId] : userIds;
    if (targetUserIds.length === 0) return;
    setBusy(true);
    setError('');
    const chunks: string[][] = [];
    for (let offset = 0; offset < targetUserIds.length; offset += ADMIN_PURGE_BULK_LIMIT) {
      chunks.push(targetUserIds.slice(offset, offset + ADMIN_PURGE_BULK_LIMIT));
    }
    // One stable key per chunk, so a retry of the same click replays instead of
    // deleting twice. The keys are tied to what they authorize: the database
    // refuses a key replayed with a different request, so keying only on the
    // chunk count meant that editing the reason and pressing delete again hit
    // IDEMPOTENCY_KEY_REUSED forever, with no way out but a page reload.
    const purgeSignature = `${reason}::${targetUserIds.join(',')}`;
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
            closeDetail();
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
      closeDetail();
      if (singleTarget) {
        if (items.some((item) => item.id === singleTarget.userId && item.status !== 'skipped'))
          await pruneDeletedUser(singleTarget.userId);
        setSingleTarget(null);
      } else clearSelection();
      setMessage(summary.headline);
      setMessageReasons(summary.reasons);
      router.refresh();
    } catch (requestError) {
      setError(clientRequestMessage(requestError, 'Удаление не выполнено.'));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Resolves to true once the server has given an answer that a retry would
   * not change, which is when a caller may let go of its idempotency key.
   */
  const runAttestationAction = async (
    body: Record<string, unknown>,
    actionKind: AttestationPendingAction['kind'],
    preserveSelection = false,
    affectedUserIds: readonly string[] = [],
    // The one row the action was started for, and whether it runs without the
    // confirmation dialog («Подтвердить и выдать» from a card or a row menu).
    target: AdminAttestationRow | null = null,
    direct = false,
  ) => {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusy(true);
    setError('');
    const fail = (text: string) => {
      // The dialog shows `error`, and so does the footer of the open card. A
      // row menu has neither, and a card may have been closed meanwhile; the
      // refusal then goes to the strip under the list.
      if (direct && detailRef.current?.recordId !== target?.recordId) {
        setMessage(text);
        setMessageReasons([]);
      } else setError(text);
    };
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
        fail(clientRequestMessage(result.error, 'Операция не выполнена. Проверьте выбор.'));
        return !result.error.retryable;
      }
      if (!payload?.items) {
        fail('Сервер вернул неполный результат. Обновите страницу и проверьте данные.');
        return false;
      }
      const summary = mutationSummary(payload.items, actionKind);
      const [only] = payload.items;
      const issueFields =
        target && payload.items.length === 1 && only?.status === 'skipped'
          ? cardIssueFields(only.reason)
          : [];
      setPending(null);
      if (target && issueFields.length > 0) {
        // The refusal names this person's own data. The card stays, or opens,
        // on exactly those fields instead of leaving a line under the list.
        setDetail((current) => (current?.recordId === target.recordId ? current : target));
        setDetailIssue({
          fields: issueFields,
          message: `Сертификат не выдан: ${skipReasonLabel(only?.reason)}.`,
        });
        writeCardParam(target.recordId);
      } else closeDetail();
      if (!preserveSelection) clearSelection();
      else await refreshResolvedSelections(affectedUserIds);
      setSingleTarget(null);
      setMessage(summary.headline);
      setMessageReasons(summary.reasons);
      router.refresh();
      return true;
    } catch (requestError) {
      fail(clientRequestMessage(requestError, 'Операция не выполнена.'));
      return false;
    } finally {
      inFlightRef.current = false;
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
    const targetUserIds = singleTarget ? [singleTarget.userId] : userIds;
    const targetAttestationIds = singleTarget
      ? singleTarget.attestationId
        ? [singleTarget.attestationId]
        : []
      : attestationIds;
    const body =
      pending.kind === 'confirm'
        ? { action: 'confirm', userIds: targetUserIds, idempotencyKey }
        : pending.kind === 'confirm-issue'
          ? { action: 'confirm_and_issue', attestationIds: targetAttestationIds, idempotencyKey }
          : pending.kind === 'bulk-update'
            ? {
                action: 'update',
                userIds: targetUserIds,
                field: pending.field,
                value,
                idempotencyKey,
              }
            : { action: 'issue', attestationIds: targetAttestationIds, idempotencyKey };
    await runAttestationAction(
      body,
      pending.kind,
      Boolean(singleTarget),
      singleTarget ? [singleTarget.userId] : [],
      singleTarget,
    );
  };

  // Single-row "confirm + issue" has no inputs, so it skips the dialog entirely.
  const runConfirmIssueDirect = async (row: AdminAttestationRow) => {
    if (busy || !row.attestationId) return;
    setSingleTarget(null);
    setPending(null);
    // The card is not closed here any more: closed before the answer, it left
    // a failed request with nowhere to say so. One key per row is kept until
    // the server has answered, so pressing again after a timeout replays the
    // same operation instead of starting a second one.
    let idempotencyKey = directKeysRef.current.get(row.recordId);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      directKeysRef.current.set(row.recordId, idempotencyKey);
    }
    const answered = await runAttestationAction(
      { action: 'confirm_and_issue', attestationIds: [row.attestationId], idempotencyKey },
      'confirm-issue',
      true,
      [row.userId],
      row,
      true,
    );
    if (answered) directKeysRef.current.delete(row.recordId);
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
      {selectedCount > 0 ? (
        <aside
          aria-label="Выбранные сотрудники"
          className="min-w-0 space-y-3 rounded-[var(--radius-group)] border-2 border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-3 shadow-[var(--shadow-pop)] sm:p-4"
        >
          <div className="flex min-w-0 items-start justify-between gap-2">
            {/* Counters, not a sentence: what the buttons below would act on. */}
            <p
              role="status"
              className="min-w-0 py-2 font-bold [overflow-wrap:anywhere] tabular-nums"
            >
              {[
                `Выбрано: ${selectionSummary.total}`,
                selectionSummary.pendingIdentity > 0 &&
                  `к проверке ${selectionSummary.pendingIdentity}`,
                selectionSummary.readyToIssue > 0 && `к выдаче ${selectionSummary.readyToIssue}`,
                selectionSummary.issued > 0 && `с сертификатом ${selectionSummary.issued}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <Button
              size="icon"
              variant="ghost"
              onClick={clearSelection}
              aria-label="Снять выделение"
            >
              <X />
            </Button>
          </div>
          <AttestationSelectionBanner
            selectedCount={selectedCount}
            totalFiltered={page.total}
            pageSize={page.items.length}
            isAllFilteredSelected={allFilteredSelected}
            selectingAll={selectingAll}
            onSelectAllFiltered={selectAllFiltered}
          />
          {selectionRefreshFailed ? (
            <div role="status" className="min-w-0 space-y-2 text-sm [overflow-wrap:anywhere]">
              <p>Выбор сохранён. Не удалось обновить его сводку после изменения данных.</p>
              <Button
                variant="outline"
                disabled={busy || selectingAll}
                className="h-auto min-h-11 max-w-full whitespace-normal"
                onClick={() => void refreshResolvedSelections()}
              >
                Обновить сводку выбора
              </Button>
            </div>
          ) : null}
          <AttestationBulkActionButtons
            summary={selectionSummary}
            permissions={permissions}
            busy={busy || selectingAll || selectionRefreshFailed}
            onAction={(action) => {
              setSingleTarget(null);
              setPending(action);
            }}
          />
        </aside>
      ) : null}
      <div
        role="table"
        aria-label="Аттестации сотрудников"
        // `clip`, not `hidden`: a hidden overflow made this box the scroll
        // container of the sticky column header, whose 3.5rem offset then
        // pushed it down over the first company band and the rows under it.
        className="space-y-2 @min-[760px]:space-y-0 @min-[760px]:overflow-clip @min-[760px]:rounded-xl @min-[760px]:border @min-[760px]:bg-[var(--color-surface)]"
      >
        <div
          role="row"
          className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-20 hidden min-h-9 items-center gap-x-2 bg-[var(--color-surface-muted)] px-1.5 text-left text-xs font-bold text-[var(--color-text-muted)] shadow-[0_1px_var(--color-border)] lg:top-0 @min-[760px]:grid @min-[760px]:grid-cols-[32px_minmax(0,1.2fr)_minmax(0,1.2fr)_4.75rem_44px_minmax(10.75rem,1fr)_44px] @min-[920px]:grid-cols-[32px_minmax(0,1.25fr)_minmax(0,0.95fr)_minmax(0,1.25fr)_6.5rem_44px_minmax(10.75rem,1fr)_44px]"
        >
          {/* An `sr-only` cell is absolutely positioned and therefore leaves the
              grid flow, which shifted every visible heading one column to the
              left. Keep the cell in flow and hide only its text. */}
          <span role="columnheader" aria-label="Выбор" />
          <span role="columnheader">Сотрудник</span>
          <span
            role="columnheader"
            className="hidden border-l border-[var(--color-border)] pl-2 @min-[920px]:block"
          >
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
                  // The company band is a grey strip in both themes, so it is
                  // never taken for one more person in the list and does not glare
                  // the way a white strip did on the dark theme.
                  <div
                    role="row"
                    className="mt-2 rounded-xl bg-[var(--color-band)] text-[var(--color-band-foreground)] first:mt-0 @min-[760px]:mt-0 @min-[760px]:rounded-none"
                  >
                    <div
                      role="cell"
                      className="flex min-h-12 flex-wrap items-center gap-1 px-1.5 @min-[760px]:min-h-10"
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
                        className="grid size-11 shrink-0 place-items-center rounded-lg text-[var(--color-band-foreground)]/70 transition-colors hover:bg-[var(--color-band-foreground)]/10 hover:text-[var(--color-band-foreground)] @min-[760px]:size-9"
                      >
                        <CaretDown
                          size={16}
                          weight="bold"
                          className={
                            groupCollapsed
                              ? '-rotate-90 transition-transform'
                              : 'transition-transform'
                          }
                        />
                      </button>
                      {/* A tap on the company selects everyone in it; narrowing
                          the list to one company is what the filters do. */}
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
                        className="flex min-h-11 min-w-0 flex-1 basis-[min(100%,6rem)] flex-wrap items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors hover:bg-[var(--color-band-foreground)]/10 @min-[760px]:min-h-9"
                      >
                        <span
                          aria-hidden
                          className={`text-micro grid size-[1.125rem] shrink-0 place-items-center rounded-[5px] border-2 leading-none ${
                            groupFullySelected
                              ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                              : 'border-[var(--color-band-foreground)]/60'
                          }`}
                        >
                          {groupFullySelected ? '✓' : ''}
                        </span>
                        <span className="min-w-0 flex-1 text-base font-bold [overflow-wrap:anywhere] @min-[760px]:text-sm">
                          {row.organization || 'Компания не указана'}
                        </span>
                        <span className="shrink-0 rounded-full bg-[var(--color-band-foreground)]/15 px-2 py-0.5 text-xs font-semibold tabular-nums">
                          {row.organizationGroupCount}
                        </span>
                      </button>
                      {permissions.canManageDocuments && row.organization ? (
                        <a
                          className="min-h-11 max-w-full px-2 py-2 text-sm [overflow-wrap:anywhere] underline"
                          href={
                            '/admin/settings/certificate?' +
                            new URLSearchParams({
                              organization: row.organization,
                              course: row.testId ?? '',
                              tab: 'protocol',
                            })
                          }
                        >
                          Протокол
                        </a>
                      ) : null}
                      {permissions.canManageIdentity ? (
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          disabled={selectingAll || busy}
                          className="size-11 text-[var(--color-band-foreground)]/70 hover:bg-[var(--color-band-foreground)]/10 hover:text-[var(--color-band-foreground)] @min-[760px]:size-9"
                          aria-label={`Изменить название компании: ${row.organization || 'не указана'}`}
                          title="Изменить название компании"
                          onClick={() => {
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
                          <PencilSimple />
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {!groupCollapsed ? (
                  <AttestationTableRow
                    row={row}
                    selected={selected.has(row.recordId)}
                    onSelectChange={(checked, source) => setRowSelected(row, checked, source)}
                    onOpenDetails={() => openDetail(row)}
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

      {/* Everything that comes and goes lives in this strip: a banner above the
          list pushed every company down the screen on the first tick of a
          checkbox. The list reserves the strip's height at all times, so
          selecting, exporting or finishing an action never moves a row.
          It floats above the dock, and below 360 px the dock is two rows of
          buttons: 3.5rem taller, the same figure the page reserve in the admin
          layout adds for it. */}
      <div className="sticky bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+4.5rem)] z-[var(--z-sticky)] space-y-2 min-[360px]:bottom-[calc(var(--mobile-tab-height)+var(--safe-area-bottom)+1rem)] lg:bottom-4">
        {message ? (
          <div
            role="status"
            className="glass-strong rounded-[var(--radius-group)] border border-[var(--color-primary)]/40 px-4 py-3 text-sm shadow-[var(--shadow-pop)]"
          >
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
          <div className="glass-strong flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-group)] border border-[var(--color-primary)] px-4 py-3 text-sm shadow-[var(--shadow-pop)]">
            <p>
              Формирование в браузере: {exportProgress.completed} из {exportProgress.total} PDF.
            </p>
            <Button size="sm" variant="outline" onClick={() => exportAbortRef.current?.abort()}>
              <X /> Отменить
            </Button>
          </div>
        ) : null}
      </div>

      <AttestationDetailDrawer
        row={detail}
        permissions={permissions}
        issue={detailIssue ?? undefined}
        busy={busy}
        // While a confirmation dialog is open the refusal is shown there.
        error={pending ? '' : error}
        getDraft={(recordId) => draftsRef.current.get(recordId)}
        onDraft={(recordId, draft) => {
          if (draft) draftsRef.current.set(recordId, draft);
          else draftsRef.current.delete(recordId);
        }}
        onAction={(row, action) => openSingleAction(row, action)}
        onClose={closeDetail}
        onSaved={(row, fields: AttestationIdentityFields) => {
          // Saved data answers the refusal the card was opened on.
          setDetailIssue(null);
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
          void refreshResolvedSelections([row.userId]);
          router.refresh();
        }}
        onStale={() => {
          // Another administrator saved first. The rows are read again and the
          // open card follows its own one (see the effect on `page.items`).
          setDetailIssue(null);
          router.refresh();
        }}
        onHistoryDeleted={async () => {
          if (detail) await pruneDeletedUser(detail.userId);
          closeDetail();
          router.refresh();
        }}
      />
      <AttestationsActionDialog
        config={dialogConfig}
        busy={busy}
        error={error}
        onCancel={() => {
          setSingleTarget(null);
          setPending(null);
          setError('');
        }}
        onConfirm={confirmAction}
      />
    </div>
  );
}
