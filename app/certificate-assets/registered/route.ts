import { requireUser } from '@/server/auth/session';
import { readRegisteredDocumentAsset } from '@/server/certificates/document-profiles';
import { createApiResponse } from '@/lib/security/api-response';
import { createAdminClient } from '@/server/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  let auth;
  try { auth = await requireUser({ enforceLegal: false }); }
  catch { return createApiResponse(null, { status: 401, headers: { 'Cache-Control': 'private, no-store' } }); }
  const id = new URL(request.url).searchParams.get('id') ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) return createApiResponse(null, { status: 404 });
  if (!auth.capabilities.includes('site.settings.manage')) {
    const client = createAdminClient();
    const refs = [{ profile: { stampAssetId: id } }, { profile: { commission: [{ assetId: id }] } }];
    const matches = await Promise.all(refs.map(ref => {
      let query = client.from('certificates').select('id').contains('document_snapshot', ref).limit(1);
      if (!auth.capabilities.includes('certificate.read')) query = query.eq('user_id', auth.user.id);
      return query;
    }));
    if (matches.some(result => result.error) || !matches.some(result => result.data?.length)) return createApiResponse(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  }
  const bytes = await readRegisteredDocumentAsset(id);
  if (!bytes) return createApiResponse(null, { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return createApiResponse(Buffer.from(bytes), { headers: { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable' } });
}
