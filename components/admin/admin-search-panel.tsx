'use client';

import { useEffect, useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { SpinnerGap } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { AdminFilterSelect } from '@/components/admin/admin-filter-select';
import { rememberAdminListQuery } from '@/components/admin/use-admin-list-href';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ADMIN_LIST_QUERY_MAX,
  listHref,
  listQuery,
  readListFilters,
  type AdminListFilters,
  type AdminListPath,
} from '@/lib/admin/list-return';

function formField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * The one search panel of «Курсы» and «Материалы»: the name, the status and
 * the magnifier. It is a real GET form, so it searches before the page
 * hydrates; after that a submit becomes a single client navigation.
 *
 * `q` and `status` are the APPLIED filters, the ones the list below was built
 * from. The fields follow the person in between: the select submits the whole
 * form, so a typed name that was never sent goes along with the status.
 */
export function AdminSearchPanel({
  basePath,
  q,
  status,
  searchLabel,
  statusLabel,
}: AdminListFilters & {
  basePath: AdminListPath;
  searchLabel: string;
  statusLabel: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [ready, setReady] = useState(false);
  const [text, setText] = useState(q);
  const [selected, setSelected] = useState(status);
  const [applied, setApplied] = useState<AdminListFilters>({ q, status });
  // The navigation in flight, and the name as it was typed when it started.
  const [sent, setSent] = useState<{ href: string; text: string } | null>(null);

  // The list answered with other filters. The name field takes the applied
  // value back only when the applied name changed, and not over letters typed
  // while the answer was on its way; a refresh after a deletion changes neither.
  if (applied.q !== q || applied.status !== status) {
    setApplied({ q, status });
    if (applied.q !== q && (sent === null || sent.text === text)) setText(q);
    setSelected(status);
    setSent(null);
  }

  const appliedQuery = listQuery({ q, status });

  useEffect(() => {
    setReady(true);
  }, []);

  useEffect(() => {
    rememberAdminListQuery(basePath, appliedQuery);
  }, [basePath, appliedQuery]);

  // A navigation that ended without new filters leaves nothing in flight.
  useEffect(() => {
    if (!isPending) setSent(null);
  }, [isPending]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const typed = formField(data, 'q');
    const next = readListFilters({ q: typed, status: formField(data, 'status') });
    // The select shows the choice at once instead of waiting for the list.
    setSelected(next.status);
    const target = listHref(basePath, listQuery(next));
    // Enter and then a click, or the select and then the magnifier, is one search.
    if (target === (sent?.href ?? listHref(basePath, appliedQuery))) return;
    setSent({ href: target, text: typed });
    startTransition(() => router.replace(target, { scroll: false }));
  };

  return (
    <form
      action={basePath}
      method="get"
      data-admin-search-panel
      data-client-ready={ready ? 'true' : 'false'}
      aria-busy={isPending || undefined}
      onSubmit={submit}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-[var(--radius-group)] bg-[var(--color-surface-muted)] p-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
    >
      <Input
        type="search"
        name="q"
        value={text}
        maxLength={ADMIN_LIST_QUERY_MAX}
        placeholder="Поиск по названию"
        aria-label={searchLabel}
        onChange={(event) => setText(event.target.value)}
        className="col-span-2 sm:col-span-1"
      />
      <AdminFilterSelect name="status" value={selected} aria-label={statusLabel}>
        <option value="">Все статусы</option>
        <option value="draft">Черновики</option>
        <option value="published">Опубликованные</option>
      </AdminFilterSelect>
      <Button type="submit" size="icon" aria-label="Найти" title="Найти">
        {/* Both glyphs take the icon button's one size, so nothing moves while the list loads. */}
        {isPending ? (
          <SpinnerGap aria-hidden className="animate-spin motion-reduce:animate-none" />
        ) : (
          <MagnifyingGlass aria-hidden />
        )}
      </Button>
    </form>
  );
}
