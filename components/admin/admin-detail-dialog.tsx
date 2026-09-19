'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from '@phosphor-icons/react/dist/csr/X';
import { Button } from '@/components/ui/button';

export function AdminDetailDialog({
  title,
  description,
  triggerLabel = 'Открыть детали',
  children,
  readable = false,
}: {
  title: string;
  description?: string;
  triggerLabel?: string;
  children: ReactNode;
  readable?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  const close = () => {
    dialogRef.current?.close();
  };

  return (
    <>
      <Button
        ref={triggerRef}
        className={
          readable
            ? 'h-auto min-h-11 text-base [overflow-wrap:anywhere] whitespace-normal'
            : undefined
        }
        type="button"
        size="sm"
        variant="outline"
        onClick={(event) => {
          // Safari does not focus buttons on pointer activation. Give the native
          // dialog a real return target before it records the previous focus.
          event.currentTarget.focus({ preventScroll: true });
          setOpen(true);
        }}
      >
        {triggerLabel}
      </Button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          setOpen(false);
          // Let native modal focus restoration finish before restoring ours.
          requestAnimationFrame(() => {
            const trigger = triggerRef.current;
            if (!dialogRef.current?.open && trigger?.isConnected) {
              trigger.focus({ preventScroll: true });
            }
          });
        }}
        onClick={(event) => {
          if (event.target === dialogRef.current) close();
        }}
        className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(42rem,calc(100vw-1.5rem))] overflow-y-auto rounded-[var(--radius-group)] border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-4 sm:p-5">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-bold break-words">
              {title}
            </h2>
            {description && !readable ? (
              <p
                id={descriptionId}
                className="mt-1 text-sm [overflow-wrap:anywhere] text-[var(--color-text-muted)]"
              >
                {description}
              </p>
            ) : null}
          </div>
          <Button
            type="button"
            className="shrink-0"
            size="icon"
            variant="ghost"
            aria-label="Закрыть детали"
            onClick={close}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <div className="p-4 sm:p-5">
          {description && readable ? (
            <p
              id={descriptionId}
              className="mb-4 text-base [overflow-wrap:anywhere] text-[var(--color-text-muted)]"
            >
              {description}
            </p>
          ) : null}
          {children}
        </div>
      </dialog>
    </>
  );
}
