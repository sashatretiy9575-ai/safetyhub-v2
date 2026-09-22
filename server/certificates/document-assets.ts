import 'server-only';

import { createHash } from 'node:crypto';
import { DOCUMENT_STAMP_OWNER } from '@/lib/pdf/document-profile';
import { requireCapability } from '@/server/auth/session';
import {
  DOCUMENT_ASSET_MAX_BYTES,
  normalizeFacsimile,
} from '@/server/certificates/facsimile-image';
import { createAdminClient } from '@/server/supabase/admin';

const FACSIMILE_BUCKET = 'document-facsimiles';
const ASSET_COLUMNS = 'id,owner_id,kind,created_at';
/** The same pattern `document_assets.owner_id` and a signer id are checked against. */
const OWNER_ID = /^[a-z][a-z0-9-]{1,79}$/u;

type AdminClient = ReturnType<typeof createAdminClient>;
type AssetRow = { id: string; owner_id: string; kind: string; created_at: string };

export type DocumentAssetKind = 'signature' | 'stamp';
/** One row of `document_assets`, without the object key: the browser never needs it. */
export type DocumentAssetInfo = {
  id: string;
  ownerId: string;
  kind: DocumentAssetKind;
  createdAt: string;
};

export type DocumentAssetErrorCode = 'DOCUMENT_ASSET_OWNER_UNKNOWN' | 'CERTIFICATE_IMAGE_INVALID';
/** A refusal the administrator can act on; anything else is a server fault. */
export class DocumentAssetError extends Error {
  readonly code: DocumentAssetErrorCode;

  constructor(code: DocumentAssetErrorCode) {
    super(code);
    this.code = code;
  }
}

function assetInfo(row: AssetRow): DocumentAssetInfo | null {
  if (row.kind !== 'signature' && row.kind !== 'stamp') return null;
  return { id: row.id, ownerId: row.owner_id, kind: row.kind, createdAt: row.created_at };
}

function alreadyStored(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const status = 'status' in error ? Number(error.status) : NaN;
  const statusCode = 'statusCode' in error ? String(error.statusCode) : '';
  const message = 'message' in error ? String(error.message) : '';
  return status === 409 || statusCode === '409' || /already exists|duplicate/iu.test(message);
}

/**
 * Objects are named by their digest and never overwritten, so an issued
 * document keeps drawing exactly the bytes it was issued with. A name that is
 * already taken must therefore hold these very bytes; anything else under it
 * would put a wrong signature on a document, and is refused.
 */
async function storeFacsimile(
  client: AdminClient,
  objectKey: string,
  png: Uint8Array,
  sha256: string,
) {
  const uploaded = await client.storage.from(FACSIMILE_BUCKET).upload(objectKey, png, {
    contentType: 'image/png',
    cacheControl: '31536000',
    upsert: false,
  });
  if (!uploaded.error) return;
  if (!alreadyStored(uploaded.error)) throw uploaded.error;
  const stored = await client.storage.from(FACSIMILE_BUCKET).download(objectKey);
  if (stored.error) throw stored.error;
  const digest = createHash('sha256')
    .update(new Uint8Array(await stored.data.arrayBuffer()))
    .digest('hex');
  if (digest !== sha256) throw new Error('DOCUMENT_ASSET_OBJECT_MISMATCH');
}

async function registerAsset(
  client: AdminClient,
  ownerId: string,
  kind: DocumentAssetKind,
  sha256: string,
): Promise<DocumentAssetInfo> {
  const find = () =>
    client
      .from('document_assets')
      .select(ASSET_COLUMNS)
      .eq('owner_id', ownerId)
      .eq('kind', kind)
      .eq('sha256', sha256)
      .maybeSingle();
  const known = await find();
  if (known.error) throw known.error;
  let row: AssetRow | null = known.data;
  if (!row) {
    const inserted = await client
      .from('document_assets')
      .insert({ owner_id: ownerId, kind, sha256, object_key: `${sha256}.png` })
      .select(ASSET_COLUMNS)
      .single();
    if (inserted.error) {
      // Two uploads of one image race to the unique key; the loser reads the winner's row.
      const raced = await find();
      if (raced.error || !raced.data) throw inserted.error;
      row = raced.data;
    } else {
      row = inserted.data;
    }
  }
  const asset = assetInfo(row);
  if (!asset) throw new Error('DOCUMENT_ASSET_ROW_INVALID');
  return asset;
}

/**
 * Stores a new image of a signer or of the stamp and registers it to its
 * owner. It is drawn once «Общее» is saved with it: the commission names the
 * image of each person, and the database accepts only an image registered to
 * that very person. Nothing is removed and nothing is overwritten — issued
 * documents keep drawing the image they were issued with. The order, object
 * then row, leaves at worst an unused object behind, never a row without one.
 */
export async function registerDocumentAsset({
  ownerId,
  kind,
  bytes,
}: {
  ownerId: string;
  kind: DocumentAssetKind;
  bytes: Uint8Array;
}): Promise<DocumentAssetInfo> {
  await requireCapability('site.settings.manage');
  if (!OWNER_ID.test(ownerId) || (kind === 'stamp' && ownerId !== DOCUMENT_STAMP_OWNER)) {
    throw new DocumentAssetError('DOCUMENT_ASSET_OWNER_UNKNOWN');
  }
  const png = await normalizeFacsimile(bytes, { maxBytes: DOCUMENT_ASSET_MAX_BYTES });
  if (!png) throw new DocumentAssetError('CERTIFICATE_IMAGE_INVALID');
  const sha256 = createHash('sha256').update(png).digest('hex');

  const client = createAdminClient();
  await storeFacsimile(client, `${sha256}.png`, png, sha256);
  return registerAsset(client, ownerId, kind, sha256);
}
