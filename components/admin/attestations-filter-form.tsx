'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { FunnelSimple } from '@phosphor-icons/react/dist/csr/FunnelSimple';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { X } from '@phosphor-icons/react/dist/csr/X';
import { Button } from '@/components/ui/button';
import { AdminOverlay } from '@/components/admin/admin-overlay';
import { Input } from '@/components/ui/input';
import { useAttestationsModalFocus } from './use-attestations-modal-focus';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import type { AdminAttestationFilters } from '@/lib/admin/types';

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

type FilterKey = 'q' | 'organization' | 'course' | 'result' | 'certificate' | 'from' | 'to';

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

function FilterChip({ label, value, href }: { label: string; value: string; href: string }) {
  return (
    <Link
      href={href}
      className="text-caption inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border border-[var(--color-accent-amber)]/45 bg-[var(--color-accent-amber-soft)] px-3 font-semibold text-[var(--color-warning)] transition-colors hover:border-[var(--color-accent-amber)] hover:brightness-105"
      title={`Убрать фильтр: ${label}`}
    >
      <span className="truncate">
        {label}: {value}
      </span>
      <X aria-hidden size={14} className="shrink-0" />
      <span className="sr-only">Убрать фильтр</span>
    </Link>
  );
}

/**
 * The panel renders outside the form (see AdminOverlay), so every control in
 * it declares the form it submits to.
 */
const FILTER_FORM_ID = 'attestation-filters-form';

export function AttestationsFilterForm({ values }: { values: FilterValues }) {
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
      const result = await clientRequest('/api/admin/attestations/filters', {
        signal: controller.signal,
      });
      if (!result.ok) return;
      const payload = await readClientResponseJson<AdminAttestationFilters>(result.response);
      if (payload) setDictionaries(payload);
    })();
    return () => controller.abort();
  }, []);

  return (
    <form
      id={FILTER_FORM_ID}
      method="get"
      aria-labelledby="attestation-search-title"
      data-attestations-filter-form
      data-client-ready={clientReady ? 'true' : 'false'}
      className="relative space-y-2 rounded-xl border bg-[var(--color-surface)] p-2.5 sm:p-3"
    >
      <h2 id="attestation-search-title" className="sr-only">
        Поиск и фильтры
      </h2>

      {/* Keep one line when it fits; enlarged text and narrow windows may wrap. */}
      <div className="flex flex-wrap gap-2">
        <div className="relative min-w-0 flex-1 basis-[min(100%,8rem)]">
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
        <Button type="submit" size="icon" className="shrink-0" aria-label="Найти">
          <MagnifyingGlass aria-hidden />
        </Button>
        <Button
          ref={filterButtonRef}
          type="button"
          size="icon"
          className="relative shrink-0"
          variant="outline"
          aria-expanded={filtersOpen}
          aria-label={`Фильтры${activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}`}
          aria-controls="attestation-filters-panel"
          onClick={() => setFiltersOpen(true)}
        >
          <FunnelSimple aria-hidden />
          {activeFilterCount > 0 ? (
            <span
              aria-hidden
              className="text-micro absolute -top-1 -right-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-[var(--color-accent-amber)] px-1 font-black text-[#1b1205] tabular-nums"
            >
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
      </div>

      {values.query || activeFilterCount > 0 ? (
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
              value={
                {
                  pending_identity: 'Ожидает проверки',
                  ready: 'Готов к выдаче',
                  issued: 'Выдан',
                  revoked: 'Нужно выдать заново',
                }[values.certificateState]
              }
              href={removeFilterHref(values, 'certificate')}
            />
          ) : null}
          {values.from ? (
            <FilterChip
              label="С даты"
              value={values.from}
              href={removeFilterHref(values, 'from')}
            />
          ) : null}
          {values.to ? (
            <FilterChip label="По дату" value={values.to} href={removeFilterHref(values, 'to')} />
          ) : null}
        </div>
      ) : null}

      <AdminOverlay lockScroll={false}>
        {filtersOpen ? (
          <button
            type="button"
            aria-label="Закрыть фильтры"
            data-attestation-filters-backdrop
            className="fixed inset-0 z-[var(--z-header)] bg-black/45 @min-[760px]:hidden"
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
              ? 'fixed inset-x-3 bottom-3 z-[var(--z-overlay)] block max-h-[88dvh] overflow-y-auto rounded-3xl border bg-[var(--color-surface)] p-4 pb-[calc(1rem+var(--safe-area-bottom))] shadow-[var(--shadow-pop)] lg:max-h-[min(42rem,calc(100dvh-8rem))] @min-[760px]:top-[4.5rem] @min-[760px]:right-3 @min-[760px]:bottom-auto @min-[760px]:left-auto @min-[760px]:max-h-[min(42rem,calc(100dvh-8rem-var(--mobile-tab-height)))] @min-[760px]:w-[min(52rem,calc(100%-1.5rem))] @min-[760px]:rounded-[var(--radius-group)] @min-[760px]:pb-4'
              : 'hidden'
          }`}
        >
          <div className="mb-4 flex items-center justify-between">
            <h3 id="attestation-filters-title" className="text-lg font-bold">
              Фильтры
            </h3>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={closeFilters}
              aria-label="Закрыть"
              data-modal-initial-focus
            >
              <X />
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-2 @min-[760px]:grid-cols-4">
            <label className="block">
              <span className="sr-only">Компания</span>
              <Input
                form={FILTER_FORM_ID}
                name="organization"
                defaultValue={values.organization}
                placeholder="Точная компания"
                aria-label="Фильтр по компании"
                list="attestation-organizations"
              />
              <datalist id="attestation-organizations">
                {dictionaries.organizations.map((organization) => (
                  <option key={organization} value={organization} />
                ))}
              </datalist>
            </label>
            <label className="block">
              <span className="sr-only">Курс</span>
              <select
                form={FILTER_FORM_ID}
                name="course"
                defaultValue={values.testId ?? ''}
                className={selectClass}
                aria-label="Курс"
              >
                <option value="">Все курсы</option>
                {dictionaries.courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="sr-only">Результат</span>
              <select
                form={FILTER_FORM_ID}
                name="result"
                defaultValue={values.resultState ?? ''}
                className={selectClass}
                aria-label="Результат"
              >
                <option value="">Все результаты</option>
                <option value="passed">Сдан</option>
                <option value="failed">Не сдан</option>
              </select>
            </label>
            <label className="block">
              <span className="sr-only">Состояние сертификата</span>
              <select
                form={FILTER_FORM_ID}
                name="certificate"
                defaultValue={values.certificateState ?? ''}
                className={selectClass}
                aria-label="Состояние сертификата"
              >
                <option value="">Все состояния сертификата</option>
                <option value="pending_identity">Ожидает проверки</option>
                <option value="ready">Готов к выдаче</option>
                <option value="issued">Выдан</option>
                <option value="revoked">Нужно выдать заново</option>
              </select>
            </label>
            {/* A date input draws its own dd.mm.yyyy, so a placeholder cannot
                name it. The two fields share one frame that reads "с … по …"
                instead of carrying a caption each. */}
            <div className="flex min-h-11 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 shadow-[var(--shadow-soft)] md:col-span-2">
              <span aria-hidden className="text-caption text-[var(--color-text-subtle)]">
                с
              </span>
              <input
                form={FILTER_FORM_ID}
                type="date"
                name="from"
                defaultValue={values.from}
                aria-label="Дата результата с"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none"
              />
              <span aria-hidden className="text-caption text-[var(--color-text-subtle)]">
                по
              </span>
              <input
                form={FILTER_FORM_ID}
                type="date"
                name="to"
                defaultValue={values.to}
                aria-label="Дата результата по"
                className="min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none"
              />
            </div>
            <label className="block">
              <span className="sr-only">Сортировка</span>
              <select
                form={FILTER_FORM_ID}
                name="sort"
                defaultValue={values.sort}
                className={selectClass}
                aria-label="Сортировка"
              >
                <option value="completed_desc">Сначала новые</option>
                <option value="completed_asc">Сначала старые</option>
                <option value="name_asc">Фамилия и имя</option>
                <option value="organization_asc">Компания, затем ФИО</option>
                <option value="score_desc">Сначала высокий балл</option>
                <option value="score_asc">Сначала низкий балл</option>
              </select>
            </label>
            <label className="block">
              <span className="sr-only">Строк на странице</span>
              <select
                form={FILTER_FORM_ID}
                name="pageSize"
                defaultValue={values.pageSize}
                className={selectClass}
                aria-label="Строк на странице"
              >
                <option value="25">25 строк</option>
                <option value="50">50 строк</option>
                <option value="100">100 строк</option>
              </select>
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="submit" size="sm" form={FILTER_FORM_ID}>
              Применить фильтры
            </Button>
            <Button asChild type="button" size="sm" variant="outline">
              <Link href="/admin/employees">Сбросить</Link>
            </Button>
          </div>
        </div>
      </AdminOverlay>
    </form>
  );
}
