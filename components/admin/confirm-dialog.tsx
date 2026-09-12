'use client';

import { useEffect, useState } from 'react';
import { DestructiveDialog } from '@/components/admin/destructive-dialog';

export type ConfirmDialogOptions = Readonly<{
  title: string;
  description: string;
  tone?: 'danger' | 'primary';
  confirmLabel?: string;
  busyLabel?: string;
  /** Checkbox text; omit for a plain two-button question. */
  acknowledgement?: string;
}>;

type PendingConfirmation = Readonly<{
  options: ConfirmDialogOptions;
  resolve: (confirmed: boolean) => void;
}>;

let pending: PendingConfirmation | null = null;
const hosts = new Set<(request: PendingConfirmation | null) => void>();

function announce() {
  for (const host of hosts) host(pending);
}

function settle(confirmed: boolean) {
  const current = pending;
  pending = null;
  announce();
  current?.resolve(confirmed);
}

/**
 * Asks the person a yes/no question in the admin dialog and resolves with the
 * answer, from anywhere in a client component:
 *
 *   if (!(await confirmDialog({ title: 'Удалить урок?', description: '…' }))) return;
 *
 * The thirteen `window.confirm` calls this replaced blocked the page, could
 * not be styled, and on iOS showed the site's origin above the question. The
 * dialog is rendered once by `ConfirmDialogHost` in the admin layout; a
 * component mounted without a host falls back to the native prompt so it can
 * never hang.
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (hosts.size === 0) {
    return Promise.resolve(window.confirm(`${options.title}\n\n${options.description}`));
  }
  if (pending) pending.resolve(false);
  return new Promise<boolean>((resolve) => {
    pending = { options, resolve };
    announce();
  });
}

export function ConfirmDialogHost() {
  const [request, setRequest] = useState<PendingConfirmation | null>(pending);

  useEffect(() => {
    hosts.add(setRequest);
    setRequest(pending);
    return () => {
      hosts.delete(setRequest);
    };
  }, []);

  if (!request) return null;
  const { options } = request;
  return (
    <DestructiveDialog
      open
      title={options.title}
      description={options.description}
      tone={options.tone ?? 'danger'}
      confirmLabel={options.confirmLabel}
      busyLabel={options.busyLabel}
      acknowledgement={options.acknowledgement ?? null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      onConfirm={() => settle(true)}
    />
  );
}
