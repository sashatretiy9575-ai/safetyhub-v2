import 'server-only';
import sharp from 'sharp';
import { createAdminClient } from '@/server/supabase/admin';
import { createApiResponse } from '@/lib/security/api-response';
import { isOwnedAvatarObjectKey } from '@/server/profile/avatar-manifests';

/** Call only after the request has passed its certificate or identity access gate. */
export async function certificatePhotoResponse(userId: string, originalWebp = false) {
  const client = createAdminClient();
  const { data, error } = await client.rpc('get_profile_avatar_manifest', { p_user_id: userId });
  if (error) throw error;
  const manifest = data as { objectKey?: string; legacyImported?: boolean } | null;
  const key = manifest?.objectKey;
  const owned = key && isOwnedAvatarObjectKey(userId, key, manifest.legacyImported === true);
  if (!key || !owned) return createApiResponse(null, { status: 404 });
  const image = await client.storage.from('profile-avatars').download(key);
  if (image.error || !image.data || image.data.size > 100 * 1024) return createApiResponse(null, { status: 503 });
  if (originalWebp) return createApiResponse(await image.data.arrayBuffer(), { headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  const jpeg = await sharp(Buffer.from(await image.data.arrayBuffer()), { limitInputPixels: 16_000_000 }).rotate().resize({ width: 900, height: 1200, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).jpeg({ quality: 92 }).toBuffer();
  if (jpeg.length > 600 * 1024) return createApiResponse(null, { status: 503 });
  return createApiResponse(new Uint8Array(jpeg).buffer, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}
