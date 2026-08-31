import { z } from 'zod';
import { createApiResponse, NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { retireCoursePresentation } from '@/features/admin/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';

const paramsSchema = z.object({
  courseId: z.string().uuid(),
  presentationId: z.string().uuid(),
});
const previewQuerySchema = z.object({
  asset: z.enum(['presentation', 'thumbnail']).default('presentation'),
  download: z.literal('1').optional(),
});

function isSafeStoragePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function presentationResponseHeaders({
  courseId,
  asset,
  download,
  contentLength,
}: {
  courseId: string;
  asset: 'presentation' | 'thumbnail';
  download: boolean;
  contentLength: number;
}) {
  const filename = asset === 'presentation' ? `${courseId}.pdf` : `${courseId}-thumbnail.webp`;
  const disposition = asset === 'presentation' && download ? 'attachment' : 'inline';
  return new Headers({
    'Cache-Control': 'private, no-store, max-age=0',
    'Content-Disposition': `${disposition}; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Content-Length': String(contentLength),
    'Content-Type': asset === 'presentation' ? 'application/pdf' : 'image/webp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string; presentationId: string }> },
) {
  try {
    const [params, query] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      previewQuerySchema.safeParseAsync({
        asset: new URL(request.url).searchParams.get('asset') ?? undefined,
        download: new URL(request.url).searchParams.get('download') ?? undefined,
      }),
    ]);
    if (!params.success || !query.success) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    await requireCapability('test.manage');
    const admin = createAdminClient();
    const { data: presentation, error: presentationError } = await admin
      .from('course_presentations')
      .select('course_id,storage_bucket,storage_path,thumbnail_path,status,byte_size')
      .eq('id', params.data.presentationId)
      .eq('course_id', params.data.courseId)
      .maybeSingle();
    if (
      presentationError ||
      !presentation ||
      presentation.status !== 'ready' ||
      presentation.storage_bucket !== 'course-presentations'
    ) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    const objectPath =
      query.data.asset === 'presentation' ? presentation.storage_path : presentation.thumbnail_path;
    if (!isSafeStoragePath(objectPath)) {
      return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 });
    }

    // Do not redirect to a Storage signed URL: immutable objects have a long
    // CDN cache lifetime, which could outlive a short signed-token lifetime.
    // Keep the capability check and bytes in this same-origin, no-store route.
    const { data, error: downloadError } = await admin.storage
      .from(presentation.storage_bucket)
      .download(objectPath);
    if (downloadError || !data) {
      return NextResponse.json({ error: 'PRESENTATION_PREVIEW_UNAVAILABLE' }, { status: 503 });
    }
    if (
      query.data.asset === 'presentation' &&
      (!Number.isSafeInteger(presentation.byte_size) || data.size !== presentation.byte_size)
    ) {
      return NextResponse.json({ error: 'PRESENTATION_PREVIEW_UNAVAILABLE' }, { status: 503 });
    }
    return createApiResponse(data.stream(), {
      status: 200,
      headers: presentationResponseHeaders({
        courseId: params.data.courseId,
        asset: query.data.asset,
        download: query.data.download === '1',
        contentLength: data.size,
      }),
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ courseId: string; presentationId: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const retired = await retireCoursePresentation(
      parsed.data.courseId,
      parsed.data.presentationId,
    );
    // The transaction only retires metadata. Storage bytes remain immutable
    // until the privileged reconciler leases an unreferenced retired object.
    return NextResponse.json(retired);
  } catch (error) {
    return apiError(error);
  }
}
