'use client';

import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  COURSE_ICON_CATEGORIES,
  resolveCourseIcon,
  searchCourseIcons,
  type CourseIconCategory,
  type IconId,
} from '@/lib/course-icons';
import { cn } from '@/lib/utils';

export function IconPicker({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: IconId;
  onChange: (value: IconId) => void;
}) {
  const generatedId = useId();
  const pickerId = id ?? generatedId;
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CourseIconCategory | 'Все'>('Все');
  const selected = resolveCourseIcon(value);
  const items = useMemo(() => searchCourseIcons(query, category), [category, query]);
  const SelectedIcon = selected.component;

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const currentIndex = Number(target.dataset.iconIndex);
    if (!Number.isInteger(currentIndex)) return;
    const columns = window.matchMedia('(min-width: 640px)').matches ? 8 : 6;
    const nextIndex =
      event.key === 'ArrowRight'
        ? currentIndex + 1
        : event.key === 'ArrowLeft'
          ? currentIndex - 1
          : event.key === 'ArrowDown'
            ? currentIndex + columns
            : event.key === 'ArrowUp'
              ? currentIndex - columns
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const bounded = Math.max(0, Math.min(items.length - 1, nextIndex));
    event.currentTarget.querySelector<HTMLElement>(`[data-icon-index="${bounded}"]`)?.focus();
  };

  return (
    // The icon is chosen once and then never touched, but the search field and
    // the scrolling grid used to occupy the middle of the first editor section
    // on every visit. Show the current icon and open the gallery on demand.
    <details id={pickerId} className="space-y-3">
      <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
          <SelectedIcon size={22} weight="duotone" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs text-[var(--color-text-muted)]">Значок курса</span>
          <span className="block truncate text-sm font-semibold">{selected.label}</span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-[var(--color-primary)]">Изменить</span>
      </summary>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_13rem]">
        <div>
          <Label className="sr-only" htmlFor={`${pickerId}-search`}>
            Поиск иконки
          </Label>
          <Input
            id={`${pickerId}-search`}
            type="search"
            value={query}
            placeholder="Поиск: каска, fire, транспорт…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div>
          <Label className="sr-only" htmlFor={`${pickerId}-category`}>
            Категория иконок
          </Label>
          <select
            id={`${pickerId}-category`}
            value={category}
            className="min-h-11 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm"
            onChange={(event) => setCategory(event.target.value as CourseIconCategory | 'Все')}
          >
            <option value="Все">Все категории</option>
            {COURSE_ICON_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        role="listbox"
        aria-label="Иконки курса"
        onKeyDown={navigate}
        className="mt-3 grid max-h-64 grid-cols-6 gap-1.5 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-2 sm:grid-cols-8"
      >
        {items.map((item, index) => {
          const Icon = item.component;
          const active = item.id === selected.id;
          return (
            <button
              key={item.id}
              type="button"
              role="option"
              aria-selected={active}
              aria-label={`${item.label}, ${item.category}`}
              title={item.label}
              data-icon-index={index}
              className={cn(
                'grid aspect-square min-h-10 place-items-center rounded-lg border transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-focus)]',
                active
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]'
                  : 'border-transparent bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]',
              )}
              onClick={() => onChange(item.id)}
            >
              <Icon size={22} weight={active ? 'fill' : 'regular'} aria-hidden="true" />
            </button>
          );
        })}
        {items.length === 0 ? (
          <p className="col-span-full p-4 text-center text-sm text-[var(--color-text-muted)]">
            Иконки не найдены.
          </p>
        ) : null}
      </div>
    </details>
  );
}
