'use client';

import { useState } from 'react';
import { Trash, UploadSimple } from '@phosphor-icons/react';
import { confirmDialog } from '@/components/admin/confirm-dialog';
import {
  FacsimilePicture,
  FacsimileSpinner,
  facsimileFailure,
  facsimilePaper,
  useFacsimileSource,
} from '@/components/admin/facsimile-tile';
import { clientFetch } from '@/lib/client-request';
import {
  certificateImageUrl,
  type CertificateImageKind,
} from '@/lib/pdf/certificate-client-contract';
import { prepareFacsimilePng } from '@/lib/pdf/facsimile-browser';

export type DocumentImageSlot = {
  kind: Exclude<CertificateImageKind, 'member'>;
  /** «Печать», «Подпись»: what the tile holds, and its name for a screen reader. */
  label: string;
  present: boolean;
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
      setFailure(facsimileFailure(error, 'Не сохранилось, повторите'));
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
          <ImageTile
            key={slot.kind}
            slot={slot}
            version={version}
            blocked={disabled || busy !== null}
            busy={busy === slot.kind}
            onFile={(file) => void send(slot.kind, file)}
            onRemove={() => void remove(slot)}
          />
        ))}
      </div>
      <p role="alert" className="min-h-5 text-sm text-[var(--color-danger)]">
        {failure}
      </p>
    </div>
  );
}

function ImageTile({
  slot,
  version,
  blocked,
  busy,
  onFile,
  onRemove,
}: {
  slot: DocumentImageSlot;
  version: number;
  /** The form is saving, or one of the tiles is: nothing can be picked, dropped or taken off. */
  blocked: boolean;
  /** This tile's own picture is on its way. */
  busy: boolean;
  onFile(file: File): void;
  onRemove(): void;
}) {
  const source = useFacsimileSource(onFile, blocked);
  return (
    <div className="relative min-w-0">
      <input {...source.input} />
      <button
        type="button"
        disabled={blocked}
        aria-label={`${slot.label}: ${slot.present ? 'заменить' : 'загрузить'}`}
        onClick={source.choose}
        {...source.drop}
        className={facsimilePaper(slot.present, source.over)}
      >
        {slot.present ? (
          <FacsimilePicture src={certificateImageUrl(slot.kind, version)} />
        ) : (
          <UploadSimple aria-hidden="true" size={28} />
        )}
        {busy ? <FacsimileSpinner /> : null}
      </button>
      {/* Under the picture, not over it: the bin never hides a stroke of the signature. */}
      <div className="flex min-h-11 min-w-0 items-center gap-1">
        <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-text-muted)]">
          {slot.label}
        </p>
        {slot.present ? (
          <button
            type="button"
            disabled={blocked}
            aria-label={`${slot.label}: убрать`}
            title="Убрать"
            onClick={onRemove}
            className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-danger)] disabled:opacity-50"
          >
            <Trash aria-hidden="true" size={18} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
