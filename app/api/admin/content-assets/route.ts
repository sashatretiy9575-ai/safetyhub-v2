import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { NextResponse } from '@/lib/security/api-response';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { apiError } from '@/features/auth/api-error';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

export const runtime = 'nodejs';

const SOURCE_MAX_BYTES = 8 * 1024 * 1024;
const OUTPUT_MAX_BYTES = 2 * 1024 * 1024;
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const ALLOWED_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);

function assetUrl(id: string) {
  return `/api/content-assets/${id}`;
}

export async function GET() {
  try {
    await requireCapability('content.manage');
    const { data, error } = await createAdminClient()
      .from('content_assets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    const assetIds = (data ?? []).map((asset) => asset.id);
    const usageResult = assetIds.length
      ? await createAdminClient()
          .from('content_asset_usages')
          .select('asset_id')
          .in('asset_id', assetIds)
      : { data: [], error: null };
    if (usageResult.error) throw usageResult.error;
    const usageCounts = new Map<string, number>();
    for (const usage of usageResult.data ?? []) {
      usageCounts.set(usage.asset_id, (usageCounts.get(usage.asset_id) ?? 0) + 1);
    }
    return NextResponse.json({
      items: (data ?? []).map((asset) => ({
        id: asset.id,
        url: assetUrl(asset.id),
        width: asset.width,
        height: asset.height,
        bytes: asset.byte_size,
        filename: asset.original_filename,
        status: asset.status,
        usageCount: usageCounts.get(asset.id) ?? 0,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const actor = await requireCapability('content.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);

    const declaredLength = Number(request.headers.get('content-length') ?? '0');
    if (
      !Number.isSafeInteger(declaredLength) ||
      declaredLength <= 0 ||
      declaredLength > SOURCE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES
    ) {
      return NextResponse.json({ error: 'CONTENT_ASSET_TOO_LARGE' }, { status: 413 });
    }
    const form = await request.formData();
    const source = form.get('asset');
    if (!(source instanceof File) || !ALLOWED_INPUT_TYPES.has(source.type)) {
      return NextResponse.json({ error: 'CONTENT_ASSET_FORMAT_INVALID' }, { status: 400 });
    }
    if (source.size <= 0 || source.size > SOURCE_MAX_BYTES) {
      return NextResponse.json({ error: 'CONTENT_ASSET_TOO_LARGE' }, { status: 413 });
    }

    const normalized = await (async () => {
      try {
        return await sharp(new Uint8Array(await source.arrayBuffer()), {
          failOn: 'warning',
          limitInputPixels: 40_000_000,
        })
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 82, effort: 5 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        return null;
      }
    })();
    if (!normalized) {
      return NextResponse.json({ error: 'CONTENT_ASSET_DECODE_INVALID' }, { status: 400 });
    }
    if (
      normalized.data.byteLength <= 0 ||
      normalized.data.byteLength > OUTPUT_MAX_BYTES ||
      !normalized.info.width ||
      !normalized.info.height ||
      normalized.info.width > 1600 ||
      normalized.info.height > 1600
    ) {
      return NextResponse.json({ error: 'CONTENT_ASSET_OUTPUT_INVALID' }, { status: 400 });
    }

    const sha256 = createHash('sha256').update(normalized.data).digest('hex');
    const storageKey = `${sha256.slice(0, 2)}/${sha256}.webp`;
    const admin = createAdminClient();
    const existing = await admin
      .from('content_assets')
      .select('*')
      .eq('sha256', sha256)
      .maybeSingle();
    if (existing.error) throw existing.error;
    if (existing.data) {
      return NextResponse.json({
        id: existing.data.id,
        url: assetUrl(existing.data.id),
        width: existing.data.width,
        height: existing.data.height,
        bytes: existing.data.byte_size,
        deduplicated: true,
      });
    }

    const upload = await admin.storage.from('content-media').upload(storageKey, normalized.data, {
      contentType: 'image/webp',
      cacheControl: '31536000',
      upsert: false,
    });
    if (upload.error && !String(upload.error.message).toLowerCase().includes('exist')) {
      throw upload.error;
    }
    const inserted = await admin
      .from('content_assets')
      .insert({
        storage_key: storageKey,
        mime_type: 'image/webp',
        width: normalized.info.width,
        height: normalized.info.height,
        byte_size: normalized.data.byteLength,
        sha256,
        original_filename: source.name.slice(0, 240),
        status: 'active',
        created_by: actor.user.id,
      })
      .select('*')
      .single();
    if (inserted.error) {
      const raced = await admin
        .from('content_assets')
        .select('*')
        .eq('sha256', sha256)
        .maybeSingle();
      if (raced.error || !raced.data) throw inserted.error;
      return NextResponse.json({
        id: raced.data.id,
        url: assetUrl(raced.data.id),
        width: raced.data.width,
        height: raced.data.height,
        bytes: raced.data.byte_size,
        deduplicated: true,
      });
    }
    return NextResponse.json(
      {
        id: inserted.data.id,
        url: assetUrl(inserted.data.id),
        width: inserted.data.width,
        height: inserted.data.height,
        bytes: inserted.data.byte_size,
        deduplicated: false,
      },
      { status: 201 },
    );
  } catch (error) {
    return apiError(error);
  }
}
