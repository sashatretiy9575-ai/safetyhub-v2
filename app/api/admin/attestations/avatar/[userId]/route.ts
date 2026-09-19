import { createHash } from 'node:crypto';
import { createPrivateRevalidatedResponse, NextResponse } from '@/lib/security/api-response';
import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { requireAnyCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';

export const runtime = 'nodejs';

const AVATAR_MAX_BYTES = 100 * 1024;

const paramsSchema = z.object({ userId: z.string().uuid() });
const manifestSchema = z.object({
  objectKey: z.string().min(1).max(256),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().min(1).max(AVATAR_MAX_BYTES),
  legacyImported: z.boolean(),
  updatedAt: z.string(),
});

function isOwnedAvatarObjectKey(userId: string, objectKey: string, legacyImported: boolean) {
  if (legacyImported) return objectKey === `${userId}/avatar.webp`;
  return new RegExp(
    `^${userId}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`,
    'iu',
  ).test(objectKey);
}

/** Strong validator: the quoted SHA-256 of exactly the bytes this route sends. */
function entityTag(sha256: string) {
  return `"${sha256}"`;
}

/**
 * `If-None-Match` is `*` or a comma-separated list of entity tags and compares
 * weakly (RFC 9110 §13.1.2): an intermediary that re-encodes a response hands
 * the validator back as `W/"…"`, and that must still count as the same photo.
 */
function matchesEntityTag(header: string | null, etag: string) {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || value === etag || value === `W/${etag}`;
  });
}

function avatarNotFound() {
  return NextResponse.json({ error: 'AVATAR_NOT_FOUND' }, { status: 404 });
}

function avatarNotModified(etag: string) {
  return createPrivateRevalidatedResponse(null, { status: 304, headers: { ETag: etag } });
}

type AvatarAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'get_profile_avatar_manifest',
    args: { p_user_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    // The person card shows the photo a name is checked against, to whoever
    // may read or decide on identities. The bytes come from this address rather
    // than a redirect to a signed Storage URL: no bearer URL or Storage path
    // reaches the browser, there is no second origin to connect to, and the
    // browser can revalidate its copy. Every request, a conditional one
    // included, passes the capability check before anything else happens.
    await requireAnyCapability(['identity.read', 'identity.manage']);
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }

    const admin = createAdminClient() as AvatarAdminClient;
    const manifestResult = await admin.rpc('get_profile_avatar_manifest', {
      p_user_id: parsed.data.userId,
    });
    const manifest = manifestSchema.safeParse(manifestResult.data);
    if (
      manifestResult.error ||
      !manifest.success ||
      !isOwnedAvatarObjectKey(
        parsed.data.userId,
        manifest.data.objectKey,
        manifest.data.legacyImported,
      )
    ) {
      return avatarNotFound();
    }

    const { objectKey, legacyImported } = manifest.data;
    const ifNoneMatch = request.headers.get('if-none-match');
    // An object published through the upload state machine never changes under
    // its key and the manifest records its digest, so a repeat view is answered
    // from the manifest alone, without a Storage call. Rows imported from before
    // that state machine carry a placeholder digest and size (sixty-four zeros,
    // one byte); their validator can only come from the bytes further down.
    if (!legacyImported && matchesEntityTag(ifNoneMatch, entityTag(manifest.data.sha256))) {
      return avatarNotModified(entityTag(manifest.data.sha256));
    }

    const download = await admin.storage
      .from('profile-avatars')
      .download(objectKey, {}, { cache: 'no-store' });
    if (download.error || !download.data) return avatarNotFound();
    const body = await download.data.arrayBuffer();
    if (body.byteLength < 1 || body.byteLength > AVATAR_MAX_BYTES) return avatarNotFound();
    const sha256 = createHash('sha256').update(new Uint8Array(body)).digest('hex');
    if (
      !legacyImported &&
      (body.byteLength !== manifest.data.bytes || sha256 !== manifest.data.sha256)
    ) {
      // The photo is what a name is checked against. Bytes that differ from the
      // published manifest are not that photo, and a strong validator must never
      // vouch for them.
      console.error('ADMIN_AVATAR_MANIFEST_MISMATCH');
      return avatarNotFound();
    }

    const etag = entityTag(sha256);
    // Only an imported row gets this far with a validator that still matches:
    // the download was the price of computing it, the body is still spared.
    if (matchesEntityTag(ifNoneMatch, etag)) return avatarNotModified(etag);
    return createPrivateRevalidatedResponse(body, {
      headers: {
        'Content-Type': 'image/webp',
        'Content-Length': String(body.byteLength),
        ETag: etag,
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
