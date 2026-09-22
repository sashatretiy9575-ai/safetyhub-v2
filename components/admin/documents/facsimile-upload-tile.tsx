'use client';

import { useState } from 'react';
import { Plus } from '@phosphor-icons/react';
import {
  FACSIMILE_FAILURES,
  FacsimilePicture,
  FacsimileSpinner,
  facsimileFailure,
  facsimilePaper,
  useFacsimileSource,
} from '@/components/admin/facsimile-tile';
import { clientFetch } from '@/lib/client-request';
import { retryAfterSeconds } from '@/lib/pdf/document-preview-job';
import { registeredDocumentAssetUrl } from '@/lib/pdf/document-profile';
import { prepareFacsimilePng } from '@/lib/pdf/facsimile-browser';
import { cn } from '@/lib/utils';

type Answer = { asset?: { id: string }; error?: string; retryAfter?: number };

// The route decodes the picture and stores it; the default 15 s would give up
// on an upload that lands.
const UPLOAD_TIMEOUT_MS = 60_000;
const NOT_UPLOADED = 'Не загрузилось, повторите';

/** Stores the prepared picture under its owner and answers with its id, or the words of a refusal. */
async function uploadFacsimile(
  ownerId: string,
  kind: 'signature' | 'stamp',
  body: Blob,
): Promise<{ assetId: string } | { failure: string }> {
  const response = await clientFetch(
    '/api/admin/documents/assets?' + new URLSearchParams({ owner: ownerId, kind }),
    { method: 'PUT', headers: { 'content-type': 'image/png' }, body },
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  );
  const answer = (await response.json().catch(() => null)) as Answer | null;
  if (response.ok && answer?.asset?.id) return { assetId: answer.asset.id };
  if (response.status === 429) {
    const seconds = retryAfterSeconds(
      answer?.retryAfter ? String(answer.retryAfter) : response.headers.get('Retry-After'),
    );
    return { failure: `Повторите через ${Math.ceil(seconds / 60)} мин` };
  }
  if (response.status === 413) return { failure: FACSIMILE_FAILURES.FACSIMILE_TOO_LARGE };
  if (answer?.error === 'CERTIFICATE_IMAGE_INVALID') {
    return { failure: FACSIMILE_FAILURES.CERTIFICATE_IMAGE_INVALID };
  }
  return { failure: NOT_UPLOADED };
}

/**
 * A signature or the stamp: the sheet is the button, a file dropped on it or
 * picked from it is cut out of its background and stored at once. It is drawn
 * on the documents once «Общее» is saved with it; an issued document keeps the
 * image it was issued with.
 */
export function FacsimileUploadTile({
  ownerId,
  kind,
  assetId,
  label,
  placeholder,
  disabled,
  className,
  onUploaded,
}: {
  ownerId: string;
  kind: 'signature' | 'stamp';
  assetId: string | null;
  label: string;
  /** The word on an empty sheet: what goes there. */
  placeholder: string;
  disabled?: boolean;
  className?: string;
  onUploaded(assetId: string): void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const blocked = Boolean(disabled) || busy;

  async function upload(file: File) {
    setBusy(true);
    setFailure('');
    try {
      const result = await uploadFacsimile(ownerId, kind, await prepareFacsimilePng(file));
      if ('assetId' in result) onUploaded(result.assetId);
      else setFailure(result.failure);
    } catch (error) {
      setFailure(facsimileFailure(error, NOT_UPLOADED));
    } finally {
      setBusy(false);
    }
  }

  const source = useFacsimileSource((file) => void upload(file), blocked);
  const picture = assetId ? registeredDocumentAssetUrl(assetId) : null;

  return (
    <div className={cn('min-w-0', className)} aria-busy={busy || undefined}>
      <input {...source.input} />
      <button
        type="button"
        aria-label={picture ? `${label}: заменить` : `${label}: загрузить`}
        title={label}
        disabled={blocked}
        onClick={source.choose}
        {...source.drop}
        className={facsimilePaper(Boolean(picture), source.over)}
      >
        {picture ? (
          <FacsimilePicture src={picture} alt={label} />
        ) : (
          <span aria-hidden="true" className="flex flex-col items-center gap-1 text-sm">
            <Plus size={20} />
            {placeholder}
          </span>
        )}
        {busy ? <FacsimileSpinner /> : null}
      </button>
      {failure ? (
        <p role="status" className="mt-1 text-sm break-words text-[var(--color-danger)]">
          {failure}
        </p>
      ) : null}
    </div>
  );
}
