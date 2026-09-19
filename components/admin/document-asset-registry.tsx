'use client';

import { useId, useState } from 'react';
import { AdminDetailDialog } from '@/components/admin/admin-detail-dialog';
import {
  FACSIMILE_FAILURES,
  FacsimilePicture,
  FacsimileSpinner,
  facsimileFailure,
  facsimilePaper,
  useFacsimileSource,
} from '@/components/admin/facsimile-tile';
import { Button } from '@/components/ui/button';
import { BUSINESS_TIME_ZONE } from '@/i18n/config';
import { clientFetch } from '@/lib/client-request';
import type { DocumentAssetEntry, DocumentAssetInfo } from '@/lib/pdf/document-asset-registry';
import { retryAfterSeconds } from '@/lib/pdf/document-preview-job';
import { registeredDocumentAssetUrl, type DocumentProfile } from '@/lib/pdf/document-profile';
import { prepareFacsimilePng } from '@/lib/pdf/facsimile-browser';
import { cn } from '@/lib/utils';

/** What a replacement leaves behind: the new image for the index, and every profile as stored now. */
export type DocumentAssetReplaced = { asset: DocumentAssetInfo; profiles: DocumentProfile[] };

type Status = { failed: boolean; text: string };
type Answer = Partial<DocumentAssetReplaced> & {
  changed?: number;
  error?: string;
  retryAfter?: number;
};

// The route decodes the picture, stores it and rewrites every profile
// (`maxDuration = 60`); the default 15 s would give up on an upload that lands.
const UPLOAD_TIMEOUT_MS = 60_000;
const NOT_UPLOADED = 'Не загрузилось, повторите';
// The zone is pinned: the server renders this component too, on its own clock.
const SINCE = new Intl.DateTimeFormat('ru-RU', { timeZone: BUSINESS_TIME_ZONE });
// A no-break space: a tile without a picture keeps the line, so the first upload moves nothing.
const NO_DATE = '\u00a0';
const RU_PLURAL_RULES = new Intl.PluralRules('ru-RU');

// Every answer carries all the profiles, so the answers have to arrive in the
// order the replacements were made: one request at a time, whichever tile asks
// and however often the section is closed and opened in between.
let queue: Promise<unknown> = Promise.resolve();
function inTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

/** «2 из 7 программ», «1 из 21 программы»: the noun follows the total. */
function usage({ usedIn, behind }: DocumentAssetEntry) {
  if (!behind.length) return 'Все программы';
  const total = usedIn.length + behind.length;
  const noun = RU_PLURAL_RULES.select(total) === 'one' ? 'программы' : 'программ';
  return `${usedIn.length} из ${total} ${noun}`;
}

function since(createdAt: string | null) {
  const date = createdAt ? new Date(createdAt) : null;
  return date && !Number.isNaN(date.getTime()) ? `от ${SINCE.format(date)}` : null;
}

/** Sends the prepared picture and words the answer; `replaced` is what the form has to take in. */
async function replaceAsset(
  entry: DocumentAssetEntry,
  body: Blob,
): Promise<{ status: Status; replaced?: DocumentAssetReplaced }> {
  const response = await clientFetch(
    '/api/admin/documents/assets?' +
      new URLSearchParams({ owner: entry.ownerId, kind: entry.kind }),
    { method: 'PUT', headers: { 'content-type': 'image/png' }, body },
    { timeoutMs: UPLOAD_TIMEOUT_MS },
  );
  const answer = (await response.json().catch(() => null)) as Answer | null;
  // 409 is a replacement too: the image is registered and most profiles draw it.
  if ((response.ok || response.status === 409) && answer?.asset && Array.isArray(answer.profiles)) {
    const replaced = { asset: answer.asset, profiles: answer.profiles };
    if (!response.ok) {
      return {
        replaced,
        status: { failed: true, text: 'Заменено не во всех программах, повторите' },
      };
    }
    return {
      replaced,
      status: {
        failed: false,
        text: answer.changed === 0 ? 'Это изображение уже стоит' : 'Заменено — для новых выдач',
      },
    };
  }
  const failed = (text: string) => ({ status: { failed: true, text } });
  if (response.status === 429) {
    // The body and the header carry the same seconds; the header's reader bounds either.
    const seconds = retryAfterSeconds(
      answer?.retryAfter ? String(answer.retryAfter) : response.headers.get('Retry-After'),
    );
    return failed(`Повторите через ${Math.ceil(seconds / 60)} мин`);
  }
  if (response.status === 413) return failed(FACSIMILE_FAILURES.FACSIMILE_TOO_LARGE);
  if (answer?.error === 'DOCUMENT_ASSET_OWNER_UNKNOWN') {
    return failed('Подписант не найден в программах');
  }
  if (answer?.error === 'CERTIFICATE_IMAGE_INVALID') {
    return failed(FACSIMILE_FAILURES.CERTIFICATE_IMAGE_INVALID);
  }
  return failed(NOT_UPLOADED);
}

/**
 * «Подписи и печать»: the images the documents of every program really draw,
 * one tile per person and one per stamp, named by whose they are. A new file
 * is registered beside the old one and gets an address of its own, so a tile
 * can never show a picture the browser kept from before the replacement.
 */
export function DocumentAssetRegistry({
  entries,
  disabled,
  onReplaced,
}: {
  entries: readonly DocumentAssetEntry[];
  disabled?: boolean;
  /** Called for a full and for a partial replacement alike: both changed the profiles. */
  onReplaced(replaced: DocumentAssetReplaced): void;
}) {
  return (
    <div className="xs:grid-cols-2 grid min-w-0 grid-cols-1 gap-3">
      {entries.map((entry) => (
        <AssetTile
          key={`${entry.kind}:${entry.ownerId}`}
          entry={entry}
          disabled={disabled}
          onReplaced={onReplaced}
        />
      ))}
    </div>
  );
}

function AssetTile({
  entry,
  disabled,
  onReplaced,
}: {
  entry: DocumentAssetEntry;
  disabled?: boolean;
  onReplaced(replaced: DocumentAssetReplaced): void;
}) {
  // Its own, not the registry's: the other tiles stay usable while this one uploads.
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const blocked = Boolean(disabled) || busy;

  async function replace(file: File) {
    setBusy(true);
    setStatus(null);
    try {
      const body = await prepareFacsimilePng(file);
      const result = await inTurn(() => replaceAsset(entry, body));
      if (result.replaced) onReplaced(result.replaced);
      setStatus(result.status);
    } catch (error) {
      setStatus({ failed: true, text: facsimileFailure(error, NOT_UPLOADED) });
    } finally {
      setBusy(false);
    }
  }

  const source = useFacsimileSource((file) => void replace(file), blocked);
  const picture = entry.assetId ? registeredDocumentAssetUrl(entry.assetId) : null;
  const date = since(entry.createdAt);
  const heading = useId();

  return (
    // A surface, not a frame: the sheet inside is the only thing with a border.
    // Every tile has the same two buttons; the group's name says whose they are.
    <div
      role="group"
      aria-labelledby={heading}
      aria-busy={busy || undefined}
      className="flex min-w-0 flex-col rounded-[var(--radius-card)] bg-[var(--color-surface-muted)] p-3"
    >
      <input {...source.input} />
      <div {...source.drop} className={facsimilePaper(Boolean(picture), source.over)}>
        {picture ? <FacsimilePicture src={picture} /> : null}
        {busy ? <FacsimileSpinner /> : null}
      </div>
      <h2 id={heading} className="mt-3 text-sm font-semibold break-words">
        {entry.title}
      </h2>
      <div className="mt-1 mb-3 space-y-0.5 text-sm break-words text-[var(--color-text-muted)]">
        <p>{entry.role}</p>
        <p title={entry.usedIn.map((use) => use.label).join(', ') || undefined}>{usage(entry)}</p>
        <p>{date ?? NO_DATE}</p>
      </div>
      {/* Pushed to the bottom edge: the buttons of two tiles in a row stay on one line. */}
      <div className="mt-auto flex min-w-0 flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blocked}
          onClick={source.choose}
        >
          {picture ? 'Заменить' : 'Загрузить'}
        </Button>
        {/* The viewer owns its button; a fieldset is how it is disabled from outside. It
            stays in place with nothing to show, so the first upload moves nothing. */}
        <fieldset disabled={blocked || !picture} className="min-w-0">
          <AdminDetailDialog title={entry.title} triggerLabel="Посмотреть">
            {picture ? (
              // Opened in a tab of its own, dark ink would lie on the browser's dark page.
              <div className="rounded-[var(--radius-md)] bg-white p-3">
                <FacsimilePicture
                  src={picture}
                  alt={entry.title}
                  className="mx-auto h-auto max-w-full"
                />
              </div>
            ) : null}
          </AdminDetailDialog>
        </fieldset>
      </div>
      <p
        role="status"
        className={cn(
          'mt-2 min-h-5 text-sm break-words',
          status?.failed ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]',
        )}
      >
        {status?.text}
      </p>
    </div>
  );
}
