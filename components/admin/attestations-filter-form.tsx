'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FunnelSimple } from '@phosphor-icons/react/dist/csr/FunnelSimple';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { X } from '@phosphor-icons/react/dist/csr/X';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAttestationsModalFocus } from './use-attestations-modal-focus';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import type { AdminAttestationFilters } from '@/features/admin/types';

type FilterValues = {
  query: string;
  organization: string;
  testId: string | null;
  resultState: 'passed' | 'failed' | null;
  certificateState: 'pending_identity' | 'ready' | 'issued' | 'revoked' | null;
  from: string;
  to: string;
  sort:
    | 'name_asc'
    | 'organization_asc'
    | 'completed_desc'
    | 'completed_asc'
    | 'score_desc'
    | 'score_asc';
  pageSize: number;
};

type FilterKey =
  | 'q'
  | 'organization'
  | 'course'
  | 'result'
  | 'certificate'
  | 'from'
  | 'to';

const selectClass =
  'min-h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] shadow-[var(--shadow-soft)]';

function filterParams(values: FilterValues) {
  const params = new URLSearchParams();
  if (values.query) params.set('q', values.query);
  if (values.organization) params.set('organization', values.organization);
  if (values.testId) params.set('course', values.testId);
  if (values.resultState) params.set('result', values.resultState);
  if (values.certificateState) params.set('certificate', values.certificateState);
  if (values.from) params.set('from', values.from);
  if (values.to) params.set('to', values.to);
  if (values.sort !== 'completed_desc') params.set('sort', values.sort);
  if (values.pageSize !== 50) params.set('pageSize', String(values.pageSize));
  return params;
}

function removeFilterHref(values: FilterValues, key: FilterKey) {
  const params = filterParams(values);
  params.delete(key);
  const search = params.toString();
  return search ? `/admin/employees?${search}` : '/admin/employees';
}

function FilterChip({
  label,
  value,
  href,
}: {
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-11 max-w-full items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-xs font-semibold hover:bg-[var(--color-surface-muted)]"
      title={`Убрать фильтр: ${label}`}
    >
      <span className="truncate">{label}: {value}</span>
      <X aria-hidden size={14} className="shrink-0" />
      <span className="sr-only">Убрать фильтр</span>
    </Link>
  );
}

export function AttestationsFilterForm({
  values,
}: {
  values: FilterValues;
}) {
  const [clientReady, setClientReady] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [dictionaries, setDictionaries] = useState<AdminAttestationFilters>({
    organizations: [],
    courses: [],
  });
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPanelRef = useRef<HTMLDivElement>(null);
  const courseTitle =
    dictionaries.courses.find((course) => course.id === values.testId)?.title ?? '';
  const activeFilterCount = [
    values.organization,
    values.testId,
    values.resultState,
    values.certificateState,
    values.from,
    values.to,
  ].filter(Boolean).length;

  const closeFilters = useCallback(() => setFiltersOpen(false), []);
  useAttestationsModalFocus({
    open: filtersOpen,
    panelRef: filterPanelRef,
    triggerRef: filterButtonRef,
    onClose: closeFilters,
  });

  useEffect(() => {
    setClientReady(true);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const result = await clientRequest(
        '/api/admin/attestations/filters',
        { signal: controller.signal },
      );
      if (!result.ok) return;
      const payload = await readClientResponseJson<AdminAttestationFilters>(result.response);
      if (payload) setDictionaries(payload);
    })();
    return () => controller.abort();
  }, []);

  return (
    <form
      method="get"
      aria-labelledby="attestation-search-title"
      data-attestations-filter-form
      data-client-ready={clientReady ? 'true' : 'false'}
      className="relative space-y-2 rounded-xl border bg-[var(--color-surface)] p-2.5 sm:p-3"
    >
      <h2 id="attestation-search-title" className="sr-only">Поиск и фильтры</h2>

      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass
            aria-hidden
            size={18}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--color-text-subtle)]"
          />
          <Input
            name="q"
            defaultValue={values.query}
            placeholder="ФИО, компания или номер сертификата"
            aria-label="Поиск по ФИО, компании или номеру сертификата"
            className="pl-10"
          />
        </div>
        <Button type="submit" size="sm">Найти</Button>
        <Button
          ref={filterButtonRef}
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={filtersOpen}
          aria-controls="attestation-filters-panel"
          onClick={() => setFiltersOpen(true)}
        >
          <FunnelSimple /> Фильтры{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </Button>
      </div>

      {(values.query || activeFilterCount > 0) ? (
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Активные фильтры">
          {values.query ? (
            <FilterChip label="Поиск" value={values.query} href={removeFilterHref(values, 'q')} />
          ) : null}
          {values.organization ? (
            <FilterChip
              label="Компания"
              value={values.organization}
              href={removeFilterHref(values, 'organization')}
            />
          ) : null}
          {values.testId ? (
            <FilterChip
              label="Курс"
              value={courseTitle || values.testId}
              href={removeFilterHref(values, 'course')}
            />
          ) : null}
          {values.resultState ? (
            <FilterChip
              label="Результат"
              value={values.resultState === 'passed' ? 'Сдан' : 'Не сдан'}
              href={removeFilterHref(values, 'result')}
            />
          ) : null}
          {values.certificateState ? (
            <FilterChip
              label="Сертификат"
              value={{
                pending_identity: 'Ожидает проверки',
                ready: 'Готов к выдаче',
                issued: 'Выдан',
                revoked: 'Нужно выдать заново',
              }[values.certificateState]}
              href={removeFilterHref(values, 'certificate')}
            />
          ) : null}
          {values.from ? (
            <FilterChip label="С даты" value={values.from} href={removeFilterHref(values, 'from')} />
          ) : null}
          {values.to ? (
            <FilterChip label="По дату" value={values.to} href={removeFilterHref(values, 'to')} />
          ) : null}
        </div>
      ) : null}

      {filtersOpen ? (
        <button
          type="button"
          aria-label="Закрыть фильтры"
          className="fixed inset-0 z-40 bg-black/45 @min-[760px]:hidden"
          onClick={closeFilters}
        />
      ) : null}

      <div
        ref={filterPanelRef}
        tabIndex={filtersOpen ? -1 : undefined}
        id="attestation-filters-panel"
        role={filtersOpen ? 'dialog' : undefined}
        aria-modal={filtersOpen ? true : undefined}
        aria-labelledby={filtersOpen ? 'attestation-filters-title' : undefined}
        className={`${
          filtersOpen
            ? 'fixed inset-x-3 bottom-3 z-50 block max-h-[88dvh] overflow-y-auto rounded-3xl border bg-[var(--color-surface)] p-4 pb-[calc(1rem+var(--safe-area-bottom))] shadow-[var(--shadow-pop)] @min-[760px]:absolute @min-[760px]:top-[4.5rem] @min-[760px]:right-3 @min-[760px]:bottom-auto @min-[760px]:left-auto @min-[760px]:w-[min(52rem,calc(100%-1.5rem))] @min-[760px]:max-h-[min(42rem,calc(100dvh-8rem))] @min-[760px]:rounded-2xl @min-[760px]:pb-4'
            : 'hidden'
        }`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 id="attestation-filters-title" className="text-lg font-bold">Фильтры</h3>
          <Button type="button" size="icon" variant="ghost" onClick={closeFilters} aria-label="Закрыть" data-modal-initial-focus>
            <X />
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2 @min-[760px]:grid-cols-4">
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Компания
            <Input
              name="organization"
              defaultValue={values.organization}
              placeholder="Точная компания"
              aria-label="Фильтр по компании"
              list="attestation-organizations"
              className="mt-1"
            />
            <datalist id="attestation-organizations">
              {dictionaries.organizations.map((organization) => (
                <option key={organization} value={organization} />
              ))}
            </datalist>
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Курс
            <select name="course" defaultValue={values.testId ?? ''} className={`${selectClass} mt-1`} aria-label="Курс">
              <option value="">Все курсы</option>
              {dictionaries.courses.map((course) => (
                <option key={course.id} value={course.id}>{course.title}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Результат
            <select name="result" defaultValue={values.resultState ?? ''} className={`${selectClass} mt-1`} aria-label="Результат">
              <option value="">Все результаты</option>
              <option value="passed">Сдан</option>
              <option value="failed">Не сдан</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Состояние сертификата
            <select name="certificate" defaultValue={values.certificateState ?? ''} className={`${selectClass} mt-1`} aria-label="Состояние сертификата">
              <option value="">Все состояния сертификата</option>
              <option value="pending_identity">Ожидает проверки</option>
              <option value="ready">Готов к выдаче</option>
              <option value="issued">Выдан</option>
              <option value="revoked">Нужно выдать заново</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            С даты
            <Input type="date" name="from" defaultValue={values.from} aria-label="Дата результата с" className="mt-1" />
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            По дату
            <Input type="date" name="to" defaultValue={values.to} aria-label="Дата результата по" className="mt-1" />
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Сортировка
            <select name="sort" defaultValue={values.sort} className={`${selectClass} mt-1`} aria-label="Сортировка">
              <option value="completed_desc">Сначала новые</option>
              <option value="completed_asc">Сначала старые</option>
              <option value="name_asc">Фамилия и имя</option>
              <option value="organization_asc">Компания, затем ФИО</option>
              <option value="score_desc">Сначала высокий балл</option>
              <option value="score_asc">Сначала низкий балл</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-[var(--color-text-muted)]">
            Строк на странице
            <select name="pageSize" defaultValue={values.pageSize} className={`${selectClass} mt-1`} aria-label="Строк на странице">
              <option value="25">25 строк</option>
              <option value="50">50 строк</option>
              <option value="100">100 строк</option>
            </select>
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" size="sm">Применить фильтры</Button>
          <Button asChild type="button" size="sm" variant="outline">
            <Link href="/admin/employees">Сбросить</Link>
          </Button>
        </div>
      </div>
    </form>
  );
}
