'use client';

import { useRef, useState } from 'react';
import { Trash, UploadSimple } from '@phosphor-icons/react';
import { confirmDialog } from '@/components/admin/confirm-dialog';
import { clientFetch } from '@/lib/client-request';
import {
  certificateImageUrl,
  type CertificateImageKind,
} from '@/lib/pdf/certificate-client-contract';
import { FACSIMILE_INPUT_TYPES, prepareFacsimilePng } from '@/lib/pdf/facsimile-browser';
import { cn } from '@/lib/utils';

export type DocumentImageSlot = {
  kind: Exclude<CertificateImageKind, 'member'>;
  /** «Печать», «Подпись»: what the tile holds, and its name for a screen reader. */
  label: string;
  present: boolean;
};

const FAILURES: Record<string, string> = {
  FACSIMILE_TYPE: 'Нужен файл PNG или JPG',
  FACSIMILE_TOO_LARGE: 'Файл больше 20 МБ',
  FACSIMILE_UNREADABLE: 'Файл не открывается как картинка',
  FACSIMILE_EMPTY: 'На картинке не видно чернил',
  CERTIFICATE_IMAGE_INVALID: 'Картинка не подошла, нужен PNG',
  RATE_LIMITED: 'Слишком часто, повторите через минуту',
};

/**
 * The stamp and the signature of the open document. A tile is the picture
 * itself on paper: tap it to choose another file, drop a file on it, or take
 * it off with the bin. A choice is saved at once and stays on every document
 * until the next one — it does not wait for the text fields' «Сохранить».
 */
export function DocumentImageTiles<Settings extends { version: number }>({
  slots,
  version,
  disabled,
  onSaved,
}: {
  slots: readonly DocumentImageSlot[];
  version: number;
  disabled?: boolean;
  onSaved(settings: Settings): void;
}) {
  const [busy, setBusy] = useState<DocumentImageSlot['kind'] | null>(null);
  const [failure, setFailure] = useState('');
  const [over, setOver] = useState<DocumentImageSlot['kind'] | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());

  async function send(kind: DocumentImageSlot['kind'], file: File | null) {
    if (busy) return;
    setBusy(kind);
    setFailure('');
    try {
      const body = file ? await prepareFacsimilePng(file) : null;
      const response = await clientFetch(`/api/admin/settings/certificate/image?kind=${kind}`, {
        method: body ? 'PUT' : 'DELETE',
        headers: body ? { 'content-type': 'image/png' } : undefined,
        body,
      });
      const result = (await response.json().catch(() => null)) as {
        settings?: Settings;
        error?: string;
      } | null;
      if (!response.ok || !result?.settings) {
        throw new Error(response.status === 429 ? 'RATE_LIMITED' : (result?.error ?? ''));
      }
      onSaved(result.settings);
    } catch (error) {
      setFailure(
        FAILURES[error instanceof Error ? error.message : ''] ?? 'Не сохранилось, повторите',
      );
    } finally {
      setBusy(null);
    }
  }

  /** Taking a picture off changes every document issued from now on, so it is asked first. */
  async function remove(slot: DocumentImageSlot) {
    const confirmed = await confirmDialog({
      title: `${slot.label}: убрать?`,
      description: 'Документы будут без неё, пока не загрузите новую.',
      tone: 'danger',
      confirmLabel: 'Убрать',
      busyLabel: 'Убираем…',
    });
    if (confirmed) await send(slot.kind, null);
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        {slots.map((slot) => (
          <div key={slot.kind} className="relative min-w-0">
            <input
              ref={(element) => {
                if (element) inputs.current.set(slot.kind, element);
                else inputs.current.delete(slot.kind);
              }}
              type="file"
              accept={FACSIMILE_INPUT_TYPES}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                event.target.value = '';
                if (file) void send(slot.kind, file);
              }}
            />
            <button
              type="button"
              disabled={disabled || busy !== null}
              aria-label={`${slot.label}: ${slot.present ? 'заменить' : 'загрузить'}`}
              onClick={() => inputs.current.get(slot.kind)?.click()}
              onDragOver={(event) => {
                event.preventDefault();
                setOver(slot.kind);
              }}
              onDragLeave={() => setOver(null)}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const file = event.dataTransfer.files?.[0];
                if (file) void send(slot.kind, file);
              }}
              className={cn(
                // Ink is judged on paper, so the tile is white in the dark theme too.
                'relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-[var(--radius-md)] border bg-white text-neutral-500 transition disabled:cursor-not-allowed',
                slot.present
                  ? 'border-[var(--color-border)]'
                  : 'border-dashed border-[var(--color-border-strong)]',
                over === slot.kind &&
                  'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]',
              )}
            >
              {slot.present ? (
                // A private, versioned image behind the session; next/image has nothing to optimise.
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={certificateImageUrl(slot.kind, version)}
                  alt=""
                  className="size-full object-contain p-2"
                  draggable={false}
                />
              ) : (
                <UploadSimple aria-hidden="true" size={28} />
              )}
              {busy === slot.kind ? (
                <span className="absolute inset-0 flex items-center justify-center bg-white/80">
                  <span
                    role="status"
                    aria-label="Сохраняем"
                    className="size-6 animate-spin rounded-full border-2 border-neutral-700 border-r-transparent motion-reduce:animate-none"
                  />
                </span>
              ) : null}
            </button>
            {/* Under the picture, not over it: the bin never hides a stroke of the signature. */}
            <div className="flex min-h-11 min-w-0 items-center gap-1">
              <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
                {slot.label}
              </p>
              {slot.present ? (
                <button
                  type="button"
                  disabled={disabled || busy !== null}
                  aria-label={`${slot.label}: убрать`}
                  title="Убрать"
                  onClick={() => void remove(slot)}
                  className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
                >
                  <Trash aria-hidden="true" size={18} />
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      <p role="alert" className="min-h-5 text-sm text-[var(--color-danger)]">
        {failure}
      </p>
    </div>
  );
}
