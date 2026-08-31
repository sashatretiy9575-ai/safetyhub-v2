import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { renderPdfBoundaryPages } from '@/lib/pdf/server-render-validation';
import { getRpcMutationError, unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

const STAGING_BUCKET = 'course-presentations-staging';
const PUBLIC_BUCKET = 'course-presentations';
const paramsSchema = z.object({ courseId: z.string().uuid() });
const bodySchema = z.object({
  presentationId: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  pageCount: z.number().int().min(1).max(200),
});
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type ServiceRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message: string } | null;
  }>;
};

type FinalizedMetadata = {
  presentation: {
    id: string;
    courseId: string;
    storageBucket: 'course-presentations';
    storagePath: string;
    thumbnailPath: string;
    sha256: string;
    pageCount: number;
    byteSize: number;
    status: 'ready';
    validatedAt: string;
  };
  cleanup: {
    id: string;
    bucket: 'course-presentations-staging';
    path: string;
    thumbnailPath: string;
    leaseExpiresAt: string;
  } | null;
  replayed: boolean;
};

function finalizedMetadata(
  value: unknown,
  expected: {
    courseId: string;
    presentationId: string;
    sha256: string;
    pageCount: number;
    byteSize: number;
    publicPdfPath: string;
    publicThumbnailPath: string;
    stagingPdfPath: string;
    stagingThumbnailPath: string;
  },
): FinalizedMetadata | null {
  const result = value as Partial<FinalizedMetadata> | null;
  const presentation = result?.presentation;
  const cleanup = result?.cleanup;
  if (
    !result ||
    typeof result.replayed !== 'boolean' ||
    !presentation ||
    presentation.id !== expected.presentationId ||
    presentation.courseId !== expected.courseId ||
    presentation.storageBucket !== PUBLIC_BUCKET ||
    presentation.storagePath !== expected.publicPdfPath ||
    presentation.thumbnailPath !== expected.publicThumbnailPath ||
    presentation.sha256 !== expected.sha256 ||
    presentation.pageCount !== expected.pageCount ||
    presentation.byteSize !== expected.byteSize ||
    presentation.status !== 'ready' ||
    !Number.isFinite(Date.parse(presentation.validatedAt))
  ) {
    return null;
  }
  if (
    cleanup !== null &&
    (!cleanup ||
      !UUID_PATTERN.test(cleanup.id) ||
      cleanup.bucket !== STAGING_BUCKET ||
      cleanup.path !== expected.stagingPdfPath ||
      cleanup.thumbnailPath !== expected.stagingThumbnailPath ||
      !Number.isFinite(Date.parse(cleanup.leaseExpiresAt)))
  ) {
    return null;
  }
  return result as FinalizedMetadata;
}

async function commitPresentationMetadata(
  admin: ReturnType<typeof createAdminClient>,
  actorId: string,
  expected: Parameters<typeof finalizedMetadata>[1],
) {
  let response: Awaited<ReturnType<ServiceRpcClient['rpc']>>;
  try {
    response = await (admin as unknown as ServiceRpcClient).rpc(
      'finalize_course_presentation_metadata',
      {
        p_actor_id: actorId,
        p_course_id: expected.courseId,
        p_presentation_id: expected.presentationId,
        p_expected_sha256: expected.sha256,
        p_expected_page_count: expected.pageCount,
        p_expected_byte_size: expected.byteSize,
        p_expected_staging_pdf_path: expected.stagingPdfPath,
        p_expected_staging_thumbnail_path: expected.stagingThumbnailPath,
      },
    );
  } catch {
    return { state: 'ambiguous' as const };
  }
  if (response.error) {
    const code = response.error.code ?? '';
    const publicCode = ['COURSE_CATALOG_MAINTENANCE', 'CATALOG_MAINTENANCE_REQUIRED'].includes(
      response.error.message,
    )
      ? response.error.message
      : undefined;
    return /^[0-9A-Z]{5}$/iu.test(code) || /^PGRST/iu.test(code)
      ? { state: 'rejected' as const, publicCode }
      : { state: 'ambiguous' as const };
  }
  const envelopeError = getRpcMutationError(response.data);
  if (envelopeError) {
    const publicCode = ['COURSE_CATALOG_MAINTENANCE', 'CATALOG_MAINTENANCE_REQUIRED'].includes(
      envelopeError.message,
    )
      ? envelopeError.message
      : undefined;
    return { state: 'rejected' as const, publicCode };
  }
  const payload = finalizedMetadata(unwrapRpcMutationResponse(response), expected);
  return payload ? { state: 'ready' as const, payload } : { state: 'ambiguous' as const };
}

async function cleanupFinalizedStaging(
  admin: ReturnType<typeof createAdminClient>,
  cleanup: FinalizedMetadata['cleanup'],
) {
  if (!cleanup) return;
  const removed = await admin.storage
    .from(cleanup.bucket)
    .remove([cleanup.path, cleanup.thumbnailPath]);
  if (removed.error) return;
  try {
    await (admin as unknown as ServiceRpcClient).rpc('complete_course_presentation_cleanup', {
      p_presentation_ids: [cleanup.id],
    });
  } catch {
    // The retired cleanup shadow remains leaseable by the reconciler.
  }
}

function readyPresentationResponse(result: FinalizedMetadata, replayed = result.replayed) {
  return NextResponse.json({
    id: result.presentation.id,
    bucket: result.presentation.storageBucket,
    path: result.presentation.storagePath,
    thumbnailPath: result.presentation.thumbnailPath,
    pageCount: result.presentation.pageCount,
    sha256: result.presentation.sha256,
    byteSize: result.presentation.byteSize,
    status: result.presentation.status,
    replayed,
  });
}

function pdfSafety(bytes: Uint8Array) {
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 2048)));
  if (!header.startsWith('%PDF-')) return 'PRESENTATION_INVALID_PDF';
  const source = new TextDecoder('latin1').decode(bytes);
  if (/\/Encrypt\b/u.test(source)) return 'PRESENTATION_ENCRYPTED';
  if (/\/(?:JavaScript|JS|Launch|EmbeddedFiles?|Filespec|EF)\b/u.test(source))
    return 'PRESENTATION_UNSAFE_ACTION';
  return null;
}

function parsedPdfHasUnsafeObjects(document: PDFDocument) {
  return document.context
    .enumerateIndirectObjects()
    .some(([, object]) =>
      /\/(?:JavaScript|JS|Launch|EmbeddedFiles?|Filespec|EF)\b/u.test(object.toString()),
    );
}

function byteArraysEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function uploadedPublicAssetsMatch(
  admin: ReturnType<typeof createAdminClient>,
  pdfPath: string,
  thumbnailPath: string,
  pdfBytes: Uint8Array,
  thumbnailBytes: Uint8Array,
) {
  const [pdf, thumbnail] = await Promise.all([
    admin.storage.from(PUBLIC_BUCKET).download(pdfPath),
    admin.storage.from(PUBLIC_BUCKET).download(thumbnailPath),
  ]);
  if (pdf.error || thumbnail.error || !pdf.data || !thumbnail.data) return false;
  const [existingPdf, existingThumbnail] = await Promise.all([
    pdf.data.arrayBuffer(),
    thumbnail.data.arrayBuffer(),
  ]);
  return (
    byteArraysEqual(new Uint8Array(existingPdf), pdfBytes) &&
    byteArraysEqual(new Uint8Array(existingThumbnail), thumbnailBytes)
  );
}

export async function POST(request: Request, context: { params: Promise<{ courseId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      bodySchema.safeParseAsync(await readJsonBody(request, 16 * 1024)),
    ]);
    if (!params.success || !body.success)
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const actor = await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const admin = createAdminClient();
    const record = await admin
      .from('course_presentations')
      .select('*')
      .eq('id', body.data.presentationId)
      .maybeSingle();
    if (record.error) throw record.error;
    if (!record.data || record.data.created_by !== actor.user.id) {
      return NextResponse.json({ error: 'PRESENTATION_NOT_READY' }, { status: 409 });
    }
    const presentationRecord = record.data;
    const expectedCourseId = params.data.courseId;
    const derivedStagingPrefix = `${actor.user.id}/${presentationRecord.id}`;
    const stagingPdfPath =
      presentationRecord.status === 'ready'
        ? `${derivedStagingPrefix}/source.pdf`
        : presentationRecord.storage_path;
    const stagingThumbnailPath =
      presentationRecord.status === 'ready'
        ? `${derivedStagingPrefix}/thumbnail.webp`
        : presentationRecord.thumbnail_path;
    const expectedSha256 = presentationRecord.sha256;
    const expectedByteSize = presentationRecord.byte_size;
    const expectedPageCount = presentationRecord.page_count;
    if (
      presentationRecord.status === 'ready' &&
      presentationRecord.course_id === expectedCourseId &&
      presentationRecord.storage_bucket === PUBLIC_BUCKET &&
      presentationRecord.storage_path &&
      presentationRecord.thumbnail_path &&
      expectedSha256 === body.data.sha256 &&
      expectedPageCount === body.data.pageCount &&
      expectedByteSize !== null
    ) {
      const replay = await commitPresentationMetadata(admin, actor.user.id, {
        courseId: expectedCourseId,
        presentationId: presentationRecord.id,
        sha256: expectedSha256,
        pageCount: expectedPageCount,
        byteSize: expectedByteSize,
        publicPdfPath: presentationRecord.storage_path,
        publicThumbnailPath: presentationRecord.thumbnail_path,
        stagingPdfPath: `${derivedStagingPrefix}/source.pdf`,
        stagingThumbnailPath: `${derivedStagingPrefix}/thumbnail.webp`,
      });
      if (replay.state === 'ready') {
        await cleanupFinalizedStaging(admin, replay.payload.cleanup);
        return readyPresentationResponse(replay.payload, true);
      }
      // The immutable ready row is itself a durable receipt. Even if cleanup
      // cannot be re-leased during this request, serving it is safe.
      return NextResponse.json({
        id: presentationRecord.id,
        bucket: presentationRecord.storage_bucket,
        path: presentationRecord.storage_path,
        thumbnailPath: presentationRecord.thumbnail_path,
        pageCount: presentationRecord.page_count,
        sha256: presentationRecord.sha256,
        byteSize: presentationRecord.byte_size,
        status: presentationRecord.status,
        replayed: true,
      });
    }
    if (!['staging', 'validating'].includes(presentationRecord.status)) {
      return NextResponse.json({ error: 'PRESENTATION_NOT_READY' }, { status: 409 });
    }
    if (
      presentationRecord.course_id !== expectedCourseId ||
      presentationRecord.storage_bucket !== STAGING_BUCKET
    ) {
      return NextResponse.json({ error: 'PRESENTATION_VALIDATION_FAILED' }, { status: 409 });
    }
    const rejectStagedPresentation = async (
      code:
        | 'PRESENTATION_VALIDATION_FAILED'
        | 'PRESENTATION_INVALID_PDF'
        | 'PRESENTATION_ENCRYPTED'
        | 'PRESENTATION_UNSAFE_ACTION',
    ) => {
      await admin
        .from('course_presentations')
        .update({ status: 'rejected', validation_error: code })
        .eq('id', presentationRecord.id)
        .in('status', ['staging', 'validating']);
      const stagedPaths = [stagingPdfPath, stagingThumbnailPath].filter((path): path is string =>
        Boolean(path),
      );
      if (stagedPaths.length > 0) {
        await admin.storage.from(STAGING_BUCKET).remove(stagedPaths);
      }
      return NextResponse.json({ error: code }, { status: 400 });
    };
    if (
      !stagingPdfPath ||
      !stagingThumbnailPath ||
      !expectedSha256 ||
      expectedByteSize === null ||
      expectedPageCount === null ||
      expectedSha256 !== body.data.sha256 ||
      expectedPageCount !== body.data.pageCount
    ) {
      return rejectStagedPresentation('PRESENTATION_VALIDATION_FAILED');
    }
    if (presentationRecord.status === 'staging') {
      const validating = await admin
        .from('course_presentations')
        .update({ status: 'validating', validation_error: null })
        .eq('id', presentationRecord.id)
        .eq('status', 'staging')
        .select('id')
        .maybeSingle();
      if (validating.error) throw validating.error;
      if (!validating.data) {
        return NextResponse.json({ error: 'PRESENTATION_NOT_READY' }, { status: 409 });
      }
    }
    let publicPdfPath: string | null = null;
    let publicThumbnailPath: string | null = null;
    try {
      const [pdfDownload, thumbnailDownload] = await Promise.all([
        admin.storage.from(STAGING_BUCKET).download(stagingPdfPath),
        admin.storage.from(STAGING_BUCKET).download(stagingThumbnailPath),
      ]);
      if (
        pdfDownload.error ||
        thumbnailDownload.error ||
        !pdfDownload.data ||
        !thumbnailDownload.data
      ) {
        throw (
          pdfDownload.error ??
          thumbnailDownload.error ??
          new Error('PRESENTATION_UPLOAD_INCOMPLETE')
        );
      }
      const pdfBytes = new Uint8Array(await pdfDownload.data.arrayBuffer());
      const thumbnailBytes = new Uint8Array(await thumbnailDownload.data.arrayBuffer());
      const safetyError = pdfSafety(pdfBytes);
      const digest = createHash('sha256').update(pdfBytes).digest('hex');
      const parsedPdf = await PDFDocument.load(pdfBytes, {
        ignoreEncryption: false,
        throwOnInvalidObject: true,
        updateMetadata: false,
      }).catch(() => null);
      const thumbnail = await sharp(thumbnailBytes, {
        failOn: 'warning',
        limitInputPixels: 4_000_000,
      })
        .metadata()
        .catch(() => null);
      const thumbnailRatio =
        thumbnail?.width && thumbnail?.height ? thumbnail.width / thumbnail.height : 0;
      if (
        safetyError ||
        !parsedPdf ||
        (parsedPdf ? parsedPdfHasUnsafeObjects(parsedPdf) : false) ||
        parsedPdf.getPageCount() !== expectedPageCount ||
        parsedPdf.getPageCount() !== body.data.pageCount ||
        digest !== expectedSha256 ||
        pdfBytes.byteLength !== expectedByteSize ||
        !thumbnail ||
        thumbnail.format !== 'webp' ||
        !thumbnail.width ||
        !thumbnail.height ||
        thumbnail.width > 1600 ||
        thumbnail.height > 1600 ||
        Math.abs(thumbnailRatio - 16 / 9) > 0.02
      ) {
        const code = safetyError ?? 'PRESENTATION_VALIDATION_FAILED';
        return rejectStagedPresentation(code);
      }
      await renderPdfBoundaryPages(pdfBytes, expectedPageCount);
      const courseSegment = expectedCourseId;
      const publicPrefix = `${courseSegment}/${presentationRecord.id}`;
      publicPdfPath = `${publicPrefix}/${digest}.pdf`;
      publicThumbnailPath = `${publicPrefix}/${digest}-thumb.webp`;
      const [pdfUpload, thumbnailUpload] = await Promise.all([
        admin.storage.from(PUBLIC_BUCKET).upload(publicPdfPath, pdfBytes, {
          contentType: 'application/pdf',
          cacheControl: '31536000',
          upsert: false,
        }),
        admin.storage.from(PUBLIC_BUCKET).upload(publicThumbnailPath, thumbnailBytes, {
          contentType: 'image/webp',
          cacheControl: '31536000',
          upsert: false,
        }),
      ]);
      if (pdfUpload.error || thumbnailUpload.error) {
        // A lost response or concurrent replay can report "already exists".
        // Continue only when both immutable objects are byte-for-byte identical.
        if (
          !(await uploadedPublicAssetsMatch(
            admin,
            publicPdfPath,
            publicThumbnailPath,
            pdfBytes,
            thumbnailBytes,
          ))
        ) {
          throw pdfUpload.error ?? thumbnailUpload.error;
        }
      }
      const metadata = await commitPresentationMetadata(admin, actor.user.id, {
        courseId: expectedCourseId,
        presentationId: presentationRecord.id,
        sha256: digest,
        pageCount: expectedPageCount,
        byteSize: expectedByteSize,
        publicPdfPath,
        publicThumbnailPath,
        stagingPdfPath,
        stagingThumbnailPath,
      });
      if (metadata.state === 'rejected') {
        // Preserve both verified copies. A retry from `validating` performs
        // the same byte checks and replays the atomic metadata receipt.
        const publicCode = metadata.publicCode ?? 'PRESENTATION_VALIDATION_FAILED';
        return NextResponse.json(
          { error: publicCode },
          { status: publicCode === 'COURSE_CATALOG_MAINTENANCE' ? 503 : 409 },
        );
      }
      if (metadata.state === 'ambiguous') {
        // A network-lost RPC response may already have committed the ready
        // receipt. Preserve both public and staging objects; replay resolves it.
        return NextResponse.json({ error: 'PRESENTATION_VALIDATION_FAILED' }, { status: 503 });
      }
      await cleanupFinalizedStaging(admin, metadata.payload.cleanup);
      return readyPresentationResponse(metadata.payload);
    } catch (validationError) {
      const validationCode =
        validationError instanceof Error &&
        [
          'PRESENTATION_INVALID_PDF',
          'PRESENTATION_ENCRYPTED',
          'PRESENTATION_UNSAFE_ACTION',
        ].includes(validationError.message)
          ? validationError.message
          : 'PRESENTATION_VALIDATION_FAILED';
      const rejected = await admin
        .from('course_presentations')
        .update({
          status: 'rejected',
          validation_error: validationCode,
        })
        .eq('id', presentationRecord.id)
        .in('status', ['validating', 'staging'])
        .select('id')
        .maybeSingle();
      if (rejected.error) throw rejected.error;
      // Only the request that atomically retired the metadata may clean its
      // bytes. If another replay already committed `ready`, preserve them.
      if (rejected.data) {
        await admin.storage.from(STAGING_BUCKET).remove([stagingPdfPath, stagingThumbnailPath]);
      }
      if (rejected.data && (publicPdfPath || publicThumbnailPath)) {
        await admin.storage
          .from(PUBLIC_BUCKET)
          .remove(
            [publicPdfPath, publicThumbnailPath].filter((path): path is string => Boolean(path)),
          );
      }
      return NextResponse.json({ error: validationCode }, { status: 400 });
    }
  } catch (error) {
    return apiError(error);
  }
}
