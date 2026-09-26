'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CaretDown, Check, MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

type Option = { value: string; label: string };

/** A list is searched rather than scrolled from this many companies or employees. */
const SEARCH_FROM = 8;

/**
 * Company, programme, employee. The name of the field is inside the field,
 * the list opens under it and closes on a choice, a click elsewhere or Escape;
 * a long list is filtered by typing.
 */
export function DocumentSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly Option[];
  disabled?: boolean;
  onChange(value: string): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase('ru-RU');
    return needle
      ? options.filter((option) => option.label.toLocaleLowerCase('ru-RU').includes(needle))
      : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function choose(next: string) {
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
    if (next !== value) onChange(next);
  }

  return (
    <div
      ref={root}
      className="relative min-w-0"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      {/* Named by its own two lines, the field's name and the chosen value. An
          aria-label of the name alone hid the value: a screen reader heard
          «Компания», never which one. The popup is a plain list of buttons,
          not a menu, so it is a disclosure without aria-haspopup. */}
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-14 w-full min-w-0 items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 text-left shadow-[var(--shadow-soft)] transition disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-[var(--color-text-muted)]">{label}</span>
          <span
            className={cn(
              'block text-base break-words',
              selected ? 'text-[var(--color-text)]' : 'text-[var(--color-text-subtle)]',
            )}
          >
            {selected?.label ?? 'Выберите'}
          </span>
        </span>
        <CaretDown
          aria-hidden="true"
          size={16}
          className={cn('shrink-0 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className="absolute inset-x-0 top-full z-[var(--z-popover)] mt-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-elevated)] p-1 shadow-[var(--shadow-pop)]">
          {options.length >= SEARCH_FROM ? (
            <label className="relative mb-1 block">
              <MagnifyingGlass
                aria-hidden="true"
                size={16}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--color-text-muted)]"
              />
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label={`${label}: поиск`}
                placeholder="Поиск"
                className="h-11 w-full rounded-[var(--radius-sm)] bg-[var(--color-surface-muted)] pr-3 pl-9 text-base text-[var(--color-text)] placeholder:text-[var(--color-text-subtle)]"
              />
            </label>
          ) : null}
          {options.length >= SEARCH_FROM ? (
            <p role="status" className="sr-only">
              {query.trim() ? `Найдено: ${visible.length}` : ''}
            </p>
          ) : null}
          <ul id={listId} className="max-h-64 overflow-y-auto overscroll-contain">
            {visible.map((option) => (
              <li key={option.value}>
                <button
                  type="button"
                  aria-current={option.value === value ? 'true' : undefined}
                  onClick={() => choose(option.value)}
                  className={cn(
                    'flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-base break-words hover:bg-[var(--color-surface-muted)]',
                    option.value === value &&
                      'bg-[var(--color-primary-soft)] font-semibold text-[var(--color-on-primary-soft)]',
                  )}
                >
                  <span className="min-w-0 flex-1">{option.label}</span>
                  {option.value === value ? (
                    <Check aria-hidden="true" size={16} className="shrink-0" />
                  ) : null}
                </button>
              </li>
            ))}
            {visible.length ? null : (
              <li className="px-3 py-3 text-sm text-[var(--color-text-muted)]">
                Ничего не найдено
              </li>
            )}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
