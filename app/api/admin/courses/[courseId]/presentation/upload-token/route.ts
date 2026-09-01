import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { TEST_EDITOR_LIMITS } from '@/lib/admin-test-editor';

const STAGING_BUCKET = 'course-presentations-staging';
const paramsSchema = z.object({ courseId: z.string().uuid() });
const bodySchema = z.object({
  locale: z.enum(['ru', 'kk', 'en', 'zh']),
  filename: z.string().trim().min(1).max(240),
  mimeType: z.literal('application/pdf'),
  byteSize: z.number().int().positive().max(TEST_EDITOR_LIMITS.presentationMaxBytes),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  pageCount: z.number().int().min(1).max(TEST_EDITOR_LIMITS.presentationMaxPages),
});

function resumableEndpoint() {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) throw new Error('SUPABASE_URL_MISSING');
  const url = new URL(configured);
  if (url.hostname.endsWith('.supabase.co')) {
    const project = url.hostname.slice(0, -'.supabase.co'.length);
    return `${url.protocol}//${project}.storage.supabase.co/storage/v1/upload/resumable`;
  }
  return `${url.origin}/storage/v1/upload/resumable`;
}

export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      bodySchema.safeParseAsync(await readJsonBody(request, 32 * 1024)),
    ]);
    if (!params.success || !body.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const actor = await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const presentationId = randomUUID();
    // The upload id intentionally equals the durable presentation receipt so
    // a finalize replay can derive and clean both staging paths.
    const uploadId = presentationId;
    const prefix = `${actor.user.id}/${uploadId}`;
    const pdfPath = `${prefix}/source.pdf`;
    const thumbnailPath = `${prefix}/thumbnail.webp`;
    const admin = createAdminClient();
    const inserted = await admin.from('course_presentations').insert({
      id: presentationId,
      course_id: params.data.courseId,
      locale: body.data.locale,
      storage_bucket: STAGING_BUCKET,
      storage_path: pdfPath,
      thumbnail_path: thumbnailPath,
      source_filename: body.data.filename,
      mime_type: body.data.mimeType,
      byte_size: body.data.byteSize,
      sha256: body.data.sha256,
      page_count: body.data.pageCount,
      aspect_ratio: '16:9',
      status: 'staging',
      created_by: actor.user.id,
    });
    if (inserted.error) throw inserted.error;
    const [pdfSigned, thumbnailSigned] = await Promise.all([
      admin.storage.from(STAGING_BUCKET).createSignedUploadUrl(pdfPath, { upsert: false }),
      admin.storage.from(STAGING_BUCKET).createSignedUploadUrl(thumbnailPath, { upsert: false }),
    ]);
    if (pdfSigned.error || thumbnailSigned.error || !pdfSigned.data || !thumbnailSigned.data) {
      await admin.from('course_presentations').delete().eq('id', presentationId);
      throw pdfSigned.error ?? thumbnailSigned.error ?? new Error('PRESENTATION_SIGNING_FAILED');
    }
    return NextResponse.json({
      uploadId,
      presentationId,
      endpoint: resumableEndpoint(),
      bucket: STAGING_BUCKET,
      pdf: { path: pdfPath, token: pdfSigned.data.token },
      thumbnail: { path: thumbnailPath, token: thumbnailSigned.data.token },
    });
  } catch (error) {
    return apiError(error);
  }
}
