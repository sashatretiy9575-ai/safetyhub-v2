import { z } from 'zod';
import { requireAnyCapability, requireCapability } from '@/server/auth/session';
import { certificatePhotoResponse } from '@/server/certificates/photo';
import { apiError } from '@/server/auth/api-error';
import { createApiResponse } from '@/lib/security/api-response';
export const runtime = 'nodejs';
export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireCapability('site.settings.manage');
    await requireAnyCapability(['identity.read', 'identity.manage']);
    const id = z.string().uuid().safeParse((await context.params).userId);
    if (!id.success) return createApiResponse(null, { status: 404 });
    return await certificatePhotoResponse(id.data);
  } catch (error) { return apiError(error); }
}
