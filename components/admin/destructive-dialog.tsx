'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

export function DestructiveDialog({
  open,
  title,
  description,
  busy = false,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open) {
      setConfirmed(false);
      return;
    }
    const previous = document.activeElement as HTMLElement | null;
    checkboxRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      previous?.focus();
    };
  }, [busy, onOpenChange, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/55 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="w-full max-w-md rounded-2xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5 shadow-2xl"
      >
        <h2 id={titleId} className="text-xl font-bold">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
          {description}
        </p>

        <label className="mt-5 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3 text-sm font-semibold">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={confirmed}
            disabled={busy}
            className="mt-0.5 size-5 shrink-0 accent-[var(--color-danger)]"
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>Да, удалить без возможности восстановления</span>
        </label>

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button type="button" variant="danger" disabled={!confirmed || busy} onClick={onConfirm}>
            {busy ? 'Удаляем…' : 'Удалить'}
          </Button>
        </div>
      </div>
    </div>
  );
}
