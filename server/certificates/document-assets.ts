import 'server-only';

import { createHash } from 'node:crypto';
import {
  bindDocumentAsset,
  isDocumentAssetOwner,
  referencedDocumentAssetIds,
  type DocumentAssetInfo,
  type DocumentAssetKind,
} from '@/lib/pdf/document-asset-registry';
import type { DocumentProfile } from '@/lib/pdf/document-profile';
import { requireCapability } from '@/server/auth/session';
import {
  documentProfileSchema,
  readDocumentProfiles,
} from '@/server/certificates/document-profiles';
import {
  DOCUMENT_ASSET_MAX_BYTES,
  normalizeFacsimile,
} from '@/server/certificates/facsimile-image';
import { createAdminClient } from '@/server/supabase/admin';

const FACSIMILE_BUCKET = 'document-facsimiles';
const ASSET_COLUMNS = 'id,owner_id,kind,created_at';
/** The same pattern `document_assets.owner_id` is checked against. */
const OWNER_ID = /^[a-z][a-z0-9-]{1,79}$/u;
/** A profile somebody keeps saving is re-read and tried again this many times. */
const REBIND_RETRIES = 2;

type AdminClient = ReturnType<typeof createAdminClient>;
type AssetRow = { id: string; owner_id: string; kind: string; created_at: string };

export type DocumentAssetErrorCode = 'DOCUMENT_ASSET_OWNER_UNKNOWN' | 'CERTIFICATE_IMAGE_INVALID';
/** A refusal the administrator can act on; anything else is a server fault. */
export class DocumentAssetError extends Error {
  readonly code: DocumentAssetErrorCode;

  constructor(code: DocumentAssetErrorCode) {
    super(code);
    this.code = code;
  }
}

export type DocumentAssetReplacement = {
  asset: DocumentAssetInfo;
  /** Every profile as it is stored now, with its revision. */
  profiles: DocumentProfile[];
  /** How many profiles this call moved to the image. */
  changed: number;
} & (
  | { status: 'replaced' }
  // Somebody kept saving these profiles while they were being rebound. The
  // image is registered and the other profiles draw it; the same upload again
  // finishes the rest.
  | { status: 'partial'; conflicted: string[] }
);

function assetInfo(row: AssetRow): DocumentAssetInfo | null {
  if (row.kind !== 'signature' && row.kind !== 'stamp') return null;
  return { id: row.id, ownerId: row.owner_id, kind: row.kind, createdAt: row.created_at };
}

/** The registered images the profiles refer to, in one read: whose they are and since when. */
export async function readDocumentAssetIndex(
  profiles: readonly DocumentProfile[],
): Promise<DocumentAssetInfo[]> {
  await requireCapability('site.settings.manage');
  const ids = referencedDocumentAssetIds(profiles);
  if (!ids.length) return [];
  const { data, error } = await createAdminClient()
    .from('document_assets')
    .select(ASSET_COLUMNS)
    .in('id', ids);
  if (error) throw error;
  return (data ?? []).flatMap((row) => assetInfo(row) ?? []);
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

async function readProfile(client: AdminClient, id: string): Promise<DocumentProfile | null> {
  const { data, error } = await client
    .from('document_profiles')
    .select('body,version')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...documentProfileSchema.parse(data.body), revision: data.version } : null;
}

/** `conflict` is a profile that kept changing under the write; it still draws its previous image. */
async function rebindProfile(
  client: AdminClient,
  stored: DocumentProfile,
  ownerId: string,
  kind: DocumentAssetKind,
  assetId: string,
): Promise<'unchanged' | 'rebound' | 'conflict'> {
  let current: DocumentProfile | null = stored;
  for (let attempt = 0; current; attempt++) {
    const next = bindDocumentAsset(current, ownerId, kind, assetId);
    if (!next) return 'unchanged';
    const { revision, ...body } = next;
    if (!revision) throw new Error('DOCUMENT_PROFILE_REVISION_MISSING');
    // The same compare-and-swap as the profile editor: a save that landed in
    // between is never overwritten, it is read and rebound on top.
    const written = await client
      .from('document_profiles')
      .update({ body, version: revision + 1, updated_at: new Date().toISOString() })
      .eq('id', body.id)
      .eq('version', revision)
      .select('version')
      .maybeSingle();
    if (written.error) throw written.error;
    if (written.data) return 'rebound';
    if (attempt >= REBIND_RETRIES) return 'conflict';
    current = await readProfile(client, stored.id);
  }
  // The profile is gone; there is nothing left to bind.
  return 'unchanged';
}

/**
 * Registers a new image of a signer or of the stamp and moves every profile
 * that has a place for it onto the new image. Nothing is removed and nothing
 * is overwritten: issued certificates carry the old asset ids in their
 * snapshots and keep drawing the old objects. The order — object, then row,
 * then profiles — means a failure half way leaves at worst an unused object or
 * an unused row, never a profile pointing at an image that is not there.
 */
export async function replaceDocumentAsset({
  ownerId,
  kind,
  bytes,
}: {
  ownerId: string;
  kind: DocumentAssetKind;
  bytes: Uint8Array;
}): Promise<DocumentAssetReplacement> {
  await requireCapability('site.settings.manage');
  if (!OWNER_ID.test(ownerId)) throw new DocumentAssetError('DOCUMENT_ASSET_OWNER_UNKNOWN');
  const profiles = await readDocumentProfiles();
  // Only a stamp's owner is recorded on the asset rather than in the profile.
  const index = kind === 'stamp' ? await readDocumentAssetIndex(profiles) : [];
  if (!isDocumentAssetOwner(profiles, index, ownerId, kind)) {
    throw new DocumentAssetError('DOCUMENT_ASSET_OWNER_UNKNOWN');
  }

  const png = await normalizeFacsimile(bytes, { maxBytes: DOCUMENT_ASSET_MAX_BYTES });
  if (!png) throw new DocumentAssetError('CERTIFICATE_IMAGE_INVALID');
  const sha256 = createHash('sha256').update(png).digest('hex');

  const client = createAdminClient();
  await storeFacsimile(client, `${sha256}.png`, png, sha256);
  const asset = await registerAsset(client, ownerId, kind, sha256);

  // Profiles are independent rows, each with its own version: one round trip for all of them.
  const outcomes = await Promise.all(
    profiles.map((profile) => rebindProfile(client, profile, ownerId, kind, asset.id)),
  );
  const changed = outcomes.filter((outcome) => outcome === 'rebound').length;
  const conflicted = profiles
    .filter((_, at) => outcomes[at] === 'conflict')
    .map((profile) => profile.id);

  const fresh = await readDocumentProfiles();
  return conflicted.length
    ? { status: 'partial', asset, profiles: fresh, changed, conflicted }
    : { status: 'replaced', asset, profiles: fresh, changed };
}
