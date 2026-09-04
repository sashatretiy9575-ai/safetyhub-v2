'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export type AttestationDialogConfig = {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  input?: { label: string; initialValue?: string; placeholder?: string };
  reason?: { label: string; minLength: number; placeholder?: string };
  confirmationPhrase?: string;
};

export function AttestationsActionDialog({
  config,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  config: AttestationDialogConfig | null;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (values: { value: string; reason: string }) => void | Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (config && dialog && !dialog.open) {
      setValue(config.input?.initialValue ?? '');
      setReason('');
      setConfirmation('');
      dialog.showModal();
    }
    if (!config && dialog?.open) dialog.close();
  }, [config]);

  const cancel = () => {
    if (!busy) onCancel();
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
      onClose={() => {
        if (config && !busy) onCancel();
      }}
      className="m-auto w-[min(34rem,calc(100vw-1.5rem))] rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-0 text-[var(--color-text)] shadow-[var(--shadow-pop)] backdrop:bg-black/55"
    >
      {config ? (
        <form
          className="max-h-[92dvh] overflow-y-auto"
          onSubmit={(event) => {
            event.preventDefault();
            void onConfirm({ value: value.trim(), reason: reason.trim() });
          }}
        >
          <div className="space-y-2 border-b border-[var(--color-border)] p-5">
            <h2 id={titleId} className="text-lg font-bold">
              {config.title}
            </h2>
            <p id={descriptionId} className="text-sm text-[var(--color-text-muted)]">
              {config.description}
            </p>
          </div>
          <div className="space-y-4 p-5">
            {config.input ? (
              <div className="space-y-2">
                <Label htmlFor={`${titleId}-value`}>{config.input.label}</Label>
                <Input
                  id={`${titleId}-value`}
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={config.input.placeholder}
                  minLength={1}
                  maxLength={200}
                  required
                  autoFocus
                />
              </div>
            ) : null}
            {config.reason ? (
              <div className="space-y-2">
                <Label htmlFor={`${titleId}-reason`}>{config.reason.label}</Label>
                <Textarea
                  id={`${titleId}-reason`}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  minLength={config.reason.minLength}
                  maxLength={500}
                  required
                  autoFocus
                  placeholder={
                    config.reason.placeholder ?? 'Укажите причину для журнала действий'
                  }
                />
              </div>
            ) : null}
            {config.confirmationPhrase ? (
              <div className="space-y-2 rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3">
                <Label htmlFor={`${titleId}-confirmation`}>
                  Для подтверждения введите: <strong>{config.confirmationPhrase}</strong>
                </Label>
                <Input
                  id={`${titleId}-confirmation`}
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  autoComplete="off"
                  required
                />
              </div>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-[var(--color-danger)]">
                {error}
              </p>
            ) : null}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="outline" disabled={busy} onClick={cancel}>
                Отмена
              </Button>
              <Button
                type="submit"
                variant={config.tone === 'danger' ? 'danger' : 'primary'}
                disabled={
                  busy ||
                  Boolean(
                    config.confirmationPhrase && confirmation !== config.confirmationPhrase,
                  )
                }
              >
                {busy ? 'Выполняем…' : config.confirmLabel}
              </Button>
            </div>
          </div>
        </form>
      ) : null}
    </dialog>
  );
}
