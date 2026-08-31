import { NextResponse } from '@/lib/security/api-response';
import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';

const paramsSchema = z.object({ userId: z.string().uuid() });
const manifestSchema = z.object({
  objectKey: z.string().min(1).max(256),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024),
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

type AvatarAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'get_profile_avatar_manifest',
    args: { p_user_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireCapability('identity.read');
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
      return NextResponse.json({ error: 'AVATAR_NOT_FOUND' }, { status: 404 });
    }
    const { data, error } = await admin.storage
      .from('profile-avatars')
      .createSignedUrl(manifest.data.objectKey, 10 * 60);
    if (error || !data?.signedUrl) {
      return NextResponse.json({ error: 'AVATAR_NOT_FOUND' }, { status: 404 });
    }

    const response = NextResponse.redirect(data.signedUrl, 307);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    return apiError(error);
  }
}
