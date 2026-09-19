import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { apiError } from '@/server/auth/api-error';
import { createAdminClient } from '@/server/supabase/admin';
import { documentProfileSchema } from '@/server/certificates/document-profiles';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const patchSchema = z.object({ profile: documentProfileSchema, expectedVersion: z.number().int().positive() }).strict();
export async function PATCH(request: Request) {
  try {
    const invalid = invalidOriginResponse(request); if (invalid) return invalid;
    await requireCapability('site.settings.manage');
    await consumeAdminMutationQuota('site.settings.update', requestSecurityMetadata(request).ipHash);
    const parsed = patchSchema.safeParse(await readJsonBody(request, 48 * 1024));
    if (!parsed.success) return NextResponse.json({ error: 'DOCUMENT_PROFILE_INVALID', field: parsed.error.issues[0]?.path.join('.') }, { status: 400 });
    const { revision: _revision, ...body } = parsed.data.profile;
    const client = createAdminClient();
    for (const signer of body.commission) {
      if (!signer.assetId) continue;
      const asset = await client.from('document_assets').select('owner_id,kind').eq('id', signer.assetId).maybeSingle();
      if (asset.error) throw asset.error;
      if (asset.data?.owner_id !== signer.signerId || asset.data.kind !== 'signature') return NextResponse.json({ error: 'DOCUMENT_SIGNER_ASSET_MISMATCH' }, { status: 400 });
    }
    if (body.stampAssetId) {
      const asset = await client.from('document_assets').select('owner_id,kind').eq('id', body.stampAssetId).maybeSingle();
      if (asset.error) throw asset.error;
      if (asset.data?.kind !== 'stamp') return NextResponse.json({ error: 'DOCUMENT_STAMP_INVALID' }, { status: 400 });
    }
    const result = await client.from('document_profiles').update({ body, version: parsed.data.expectedVersion + 1, updated_at: new Date().toISOString() })
      .eq('id', body.id).eq('course_slug', body.courseSlug).eq('audience', body.audience).eq('version', parsed.data.expectedVersion).select('version').maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return NextResponse.json({ error: 'DOCUMENT_PROFILE_CONFLICT' }, { status: 409 });
    return NextResponse.json({ profile: { ...body, revision: result.data.version } }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
