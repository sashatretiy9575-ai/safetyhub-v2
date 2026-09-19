'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AdminOverlay } from '@/components/admin/admin-overlay';

const DEFAULT_ACKNOWLEDGEMENT = 'Подтверждаю удаление';

/**
 * The one confirmation dialog of the admin panel. It started as the deletion
 * dialog with its "yes, delete" checkbox; the same surface now also asks
 * about publishing, unpublishing and leaving an editor, so the tone, the
 * labels and the checkbox are parameters, and an error from the action is
 * shown inside instead of a browser alert.
 */
export function DestructiveDialog({
  open,
  title,
  description,
  busy = false,
  tone = 'danger',
  confirmLabel,
  busyLabel,
  acknowledgement = DEFAULT_ACKNOWLEDGEMENT,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  busy?: boolean;
  /** `danger` for anything that removes data, `primary` for publishing and similar. */
  tone?: 'danger' | 'primary';
  confirmLabel?: string;
  busyLabel?: string;
  /** Checkbox text the person must tick first; `null` removes the checkbox. */
  acknowledgement?: string | null;
  /** What went wrong on the last attempt, read out by assistive technology. */
  error?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const checkboxRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmed, setConfirmed] = useState(false);
  // Read through refs: callers pass a fresh `onOpenChange` on every render, and
  // an effect keyed on it re-ran on each of them — focus jumped back to the
  // checkbox the moment an error appeared or the action started.
  const busyRef = useRef(busy);
  const closeRef = useRef(onOpenChange);
  useEffect(() => {
    busyRef.current = busy;
    closeRef.current = onOpenChange;
  });
  const needsAcknowledgement = acknowledgement !== null;
  const resolvedConfirmLabel = confirmLabel ?? (tone === 'danger' ? 'Удалить' : 'Продолжить');
  const resolvedBusyLabel = busyLabel ?? (tone === 'danger' ? 'Удаляем…' : 'Выполняем…');

  useEffect(() => {
    if (!open) {
      setConfirmed(false);
      return;
    }
    // Taken here, before the panel exists: the overlay portals its children one
    // render after it mounts, so this is still the control that opened the dialog.
    const previous = document.activeElement as HTMLElement | null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) {
        event.preventDefault();
        closeRef.current(false);
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
  }, [open]);

  // Focus enters when the panel really attaches. The effect above runs while the
  // overlay has not portalled anything yet — its refs were still empty, focus
  // stayed on the trigger and Tab walked the page behind the dialog. Stable, so
  // it fires once per opening and never pulls focus back on a later render.
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node;
    if (node) (checkboxRef.current ?? confirmRef.current)?.focus();
  }, []);

  if (!open) return null;

  return (
    <AdminOverlay>
      <div
        className="fixed inset-0 z-[var(--z-dialog)] grid place-items-center bg-black/55 p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !busy) onOpenChange(false);
        }}
      >
        <div
          ref={attachPanel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className="w-full max-w-md rounded-[var(--radius-group)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] p-5 shadow-2xl"
        >
          <h2 id={titleId} className="text-xl font-bold break-words">
            {title}
          </h2>
          <p id={descriptionId} className="mt-2 text-sm leading-6 text-[var(--color-text-muted)]">
            {description}
          </p>

          {needsAcknowledgement ? (
            <label className="mt-5 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3 text-sm font-semibold">
              <input
                ref={checkboxRef}
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                className="mt-0.5 size-5 shrink-0 accent-[var(--color-danger)]"
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>{acknowledgement}</span>
            </label>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="mt-4 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-3 text-sm font-medium text-[var(--color-danger)]"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Отмена
            </Button>
            <Button
              ref={confirmRef}
              type="button"
              variant={tone === 'danger' ? 'danger' : 'primary'}
              disabled={(needsAcknowledgement && !confirmed) || busy}
              aria-busy={busy || undefined}
              onClick={onConfirm}
            >
              {busy ? resolvedBusyLabel : resolvedConfirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </AdminOverlay>
  );
}
