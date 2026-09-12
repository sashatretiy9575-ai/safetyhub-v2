import 'server-only';

import * as z from 'zod';
import { createAdminClient } from '@/server/supabase/admin';

const AVATAR_URL_TTL_SECONDS = 10 * 60;

const manifestSchema = z.object({
  userId: z.string().uuid(),
  objectKey: z.string().min(1).max(256),
  legacyImported: z.boolean(),
});

type ManifestRpcClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'get_profile_avatar_manifests',
    args: { p_user_ids: string[] },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export function isOwnedAvatarObjectKey(userId: string, objectKey: string, legacyImported: boolean) {
  if (legacyImported) return objectKey === `${userId}/avatar.webp`;
  return new RegExp(
    `^${userId}/objects/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.webp$`,
    'iu',
  ).test(objectKey);
}

/**
 * Signed avatar URLs for a page of accounts in two round-trips (one manifest
 * read, one batch signing) instead of three per row. Any failure leaves the
 * affected accounts without a photo; the list itself never fails because of it.
 */
export async function resolveAvatarUrls(userIds: readonly string[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  const ids = [...new Set(userIds)].slice(0, 100);
  if (ids.length === 0) return urls;
  try {
    const admin = createAdminClient() as ManifestRpcClient;
    const manifests = await admin.rpc('get_profile_avatar_manifests', { p_user_ids: ids });
    if (manifests.error) return urls;
    const parsed = z.array(manifestSchema).safeParse(manifests.data);
    if (!parsed.success) return urls;
    const owned = parsed.data.filter((manifest) =>
      isOwnedAvatarObjectKey(manifest.userId, manifest.objectKey, manifest.legacyImported),
    );
    if (owned.length === 0) return urls;
    const signed = await admin.storage
      .from('profile-avatars')
      .createSignedUrls(
        owned.map((manifest) => manifest.objectKey),
        AVATAR_URL_TTL_SECONDS,
      );
    if (signed.error || !signed.data) return urls;
    const byKey = new Map(
      signed.data
        .filter((entry) => !entry.error && entry.signedUrl && entry.path)
        .map((entry) => [entry.path as string, entry.signedUrl]),
    );
    for (const manifest of owned) {
      const url = byKey.get(manifest.objectKey);
      if (url) urls.set(manifest.userId, url);
    }
  } catch (error) {
    console.error('AVATAR_BATCH_SIGNING_FAILED', {
      cause: error instanceof Error ? error.message.slice(0, 120) : 'unknown',
    });
  }
  return urls;
}
