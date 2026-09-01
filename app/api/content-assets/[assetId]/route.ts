import { createAdminClient } from '@/lib/supabase/admin';
import { entityIdSchema } from '@/lib/validation/admin';
import { createApiResponse, createImmutableAssetResponse } from '@/lib/security/api-response';
import {
  hasExactCanonicalSearch,
  hasExactCanonicalUuidPath,
} from '@/lib/security/canonical-search';

export const runtime = 'nodejs';

export async function GET(request: Request, context: { params: Promise<{ assetId: string }> }) {
  if (!hasExactCanonicalSearch(request.url, '')) {
    return createApiResponse(null, { status: 404 });
  }
  const { assetId } = await context.params;
  if (!hasExactCanonicalUuidPath(request.url, '/api/content-assets', assetId)) {
    return createApiResponse(null, { status: 404 });
  }
  const parsed = entityIdSchema.safeParse(assetId);
  if (!parsed.success) return createApiResponse(null, { status: 404 });
  const admin = createAdminClient();
  const asset = await admin
    .from('content_assets')
    .select('*')
    .eq('id', parsed.data)
    .eq('status', 'active')
    .maybeSingle();
  if (asset.error || !asset.data) return createApiResponse(null, { status: 404 });

  const ifNoneMatch = request.headers.get('if-none-match');
  const etag = `"${asset.data.sha256}"`;
  if (ifNoneMatch === etag) {
    return createImmutableAssetResponse(null, {
      status: 304,
      headers: { ETag: etag },
    });
  }
  const download = await admin.storage.from('content-media').download(asset.data.storage_key);
  if (download.error || !download.data) return createApiResponse(null, { status: 404 });
  return createImmutableAssetResponse(await download.data.arrayBuffer(), {
    headers: {
      'Content-Type': 'image/webp',
      'Content-Length': String(asset.data.byte_size),
      ETag: etag,
    },
  });
}
