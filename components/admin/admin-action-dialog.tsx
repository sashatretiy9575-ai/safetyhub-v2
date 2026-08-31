'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Warning } from '@phosphor-icons/react/dist/csr/Warning';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type AdminActionDialogProps = {
  title: string;
  description: string;
  target: string;
  current: string;
  next: string;
  impact: readonly string[];
  confirmLabel: string;
  busy: boolean;
  error?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
};

export function AdminActionDialog({
  title,
  description,
  target,
  current,
  next,
  impact,
  confirmLabel,
  busy,
  error,
  danger = false,
  onCancel,
  onConfirm,
}: AdminActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const errorId = useId();
  const [reason, setReason] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const cancel = () => {
    if (busy) return;
    dialogRef.current?.close();
    onCancel();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        cancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) cancel();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
    >
      <form
        className="space-y-5 p-4 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = reason.trim();
          if (normalized.length < 10 || normalized.length > 500) return;
          onConfirm(normalized);
        }}
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className={`grid size-10 shrink-0 place-items-center rounded-full ${
              danger
                ? 'bg-[var(--color-danger-soft)] text-[var(--color-danger)]'
                : 'bg-[var(--color-accent-amber-soft)] text-[var(--color-warning)]'
            }`}
          >
            <Warning size={22} weight="fill" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-bold">
              {title}
            </h2>
            <p id={descriptionId} className="mt-1 text-sm text-[var(--color-text-muted)]">
              {description}
            </p>
          </div>
        </div>

        <dl className="grid gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Цель
            </dt>
            <dd className="mt-1 break-all font-semibold">{target}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-subtle)]">
              Сейчас
            </dt>
            <dd className="mt-1 font-semibold">{current}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-wide text-[var(--color-text-subtle)]">
              После
            </dt>
            <dd className="mt-1 font-semibold">{next}</dd>
          </div>
        </dl>

        <div>
          <h3 className="text-sm font-bold">Что изменится</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-[var(--color-text-muted)]">
            {impact.map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden="true">•</span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2">
          <Label htmlFor={reasonId}>Причина изменения</Label>
          <Textarea
            id={reasonId}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={10}
            maxLength={500}
            required
            autoFocus
            disabled={busy}
            invalid={reason.length > 0 && reason.trim().length < 10}
            aria-describedby={error ? errorId : undefined}
            placeholder="Не менее 10 символов; причина попадёт в журнал аудита"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--color-text-subtle)]">
            <span>Укажите причину: она попадёт в журнал аудита и поможет проверить действие позже.</span>
            <span>{reason.length}/500</span>
          </div>
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
            Отмена
          </Button>
          <Button
            type="submit"
            variant={danger ? 'danger' : 'primary'}
            disabled={busy || reason.trim().length < 10}
          >
            {busy ? 'Выполняется…' : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
