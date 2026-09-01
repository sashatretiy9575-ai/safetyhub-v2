import { AuthenticationError, requireUser } from '@/features/auth/server';
import { isContentSlug } from '@/lib/content/slug';
import { createBoundedRelayStream } from '@/lib/security/bounded-relay-stream';
import {
  consumeBusinessQuota,
  consumeCoarseQuota,
  RateLimitError,
} from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { isAppLocale, type AppLocale } from '@/i18n/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRESENTATION_BUCKET = 'course-presentations';
const PRESENTATION_MAX_BYTES = 25 * 1024 * 1024;
const THUMBNAIL_MAX_BYTES = 5 * 1024 * 1024;
const PRESENTATION_RELAY_TIMEOUT_MS = 60_000;
const PRESENTATION_LEASE_SECONDS = 90;
const ASSETS = {
  presentation: { contentType: 'application/pdf', filenameSuffix: '.pdf' },
  thumbnail: { contentType: 'image/webp', filenameSuffix: '-thumbnail.webp' },
} as const;

type Asset = keyof typeof ASSETS;
type ApprovedPresentation = {
  presentation_id: string;
  content_type: string;
  byte_size: number | null;
};

type ApprovedPresentationRpcClient = {
  rpc(
    name: 'get_approved_course_presentation_locale',
    args: { p_course_slug: string; p_asset: Asset; p_locale: AppLocale },
  ): PromiseLike<{
    data: ApprovedPresentation[] | null;
    error: { code?: string; message?: string } | null;
  }>;
};

type ServiceRpcClient = {
  rpc(
    name: 'claim_course_presentation_download_lease' | 'release_course_presentation_download_lease',
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

function securityHeaders() {
  return {
    'Cache-Control': 'private, no-store, max-age=0',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'same-origin',
    Vary: 'Cookie',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
  };
}

function blockedResponse(status: 401 | 403 | 404 | 429 | 503, retryAfter?: number) {
  const message =
    status === 401
      ? 'Authentication required'
      : status === 403
        ? 'Course access requirements are not satisfied'
        : status === 429
          ? 'Too many presentation downloads'
          : status === 503
            ? 'Course material is temporarily unavailable'
            : 'Not found';
  const headers = new Headers(securityHeaders());
  if (status === 429) headers.set('Retry-After', String(Math.max(1, Math.ceil(retryAfter ?? 1))));
  return new Response(message, { status, headers });
}

function isAsset(value: string): value is Asset {
  return value in ASSETS;
}

function isSafeStoragePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) return false;
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function parseApprovedPresentation(value: unknown, asset: Asset): ApprovedPresentation | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ApprovedPresentation>;
  const expectedType = ASSETS[asset].contentType;
  if (!isUuid(candidate.presentation_id) || candidate.content_type !== expectedType) return null;
  if (asset === 'presentation') {
    if (
      typeof candidate.byte_size !== 'number' ||
      !Number.isSafeInteger(candidate.byte_size) ||
      candidate.byte_size < 1 ||
      candidate.byte_size > 25 * 1024 * 1024
    ) {
      return null;
    }
  } else if (candidate.byte_size !== null) {
    return null;
  }
  return {
    presentation_id: candidate.presentation_id,
    content_type: candidate.content_type,
    byte_size: candidate.byte_size ?? null,
  };
}

type AuthorizedAsset = {
  actorId: string;
  slug: string;
  asset: Asset;
  presentation: ApprovedPresentation;
};

async function authorizeAsset(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
): Promise<AuthorizedAsset | Response> {
  const { slug, asset } = await context.params;
  if (!isContentSlug(slug) || !isAsset(asset)) return blockedResponse(404);

  try {
    // This checks the cookie-backed session before the DB function repeats the
    // active-account and manual-approval checks in one protected SQL call.
    const auth = await requireUser();
    const requestedLocale = new URL(request.url).searchParams.get('locale');
    const locale = isAppLocale(requestedLocale) ? requestedLocale : auth.profile.preferred_locale;

    const client = (await createClient()) as unknown as ApprovedPresentationRpcClient;
    const { data, error } = await client.rpc('get_approved_course_presentation_locale', {
      p_course_slug: slug,
      p_asset: asset,
      p_locale: locale,
    });
    if (error) {
      return ['ACCOUNT_APPROVAL_REQUIRED', 'LEGAL_ACCEPTANCE_REQUIRED'].includes(
        error.message ?? '',
      )
        ? blockedResponse(403)
        : blockedResponse(404);
    }
    if (!data || data.length !== 1) return blockedResponse(404);
    const presentation = parseApprovedPresentation(data[0], asset);
    return presentation
      ? { actorId: auth.user.id, slug, asset, presentation }
      : blockedResponse(503);
  } catch (error) {
    if (error instanceof AuthenticationError) return blockedResponse(error.status);
    return blockedResponse(503);
  }
}

function parseLeaseClaim(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { allowed?: unknown; leaseId?: unknown; retryAfter?: unknown };
  const retryAfter = Math.max(1, Math.ceil(Number(candidate.retryAfter) || 1));
  if (candidate.allowed !== true) return { allowed: false as const, retryAfter };
  if (!isUuid(candidate.leaseId)) return null;
  return { allowed: true as const, leaseId: candidate.leaseId };
}

async function claimPresentationLease(client: ServiceRpcClient, actorId: string) {
  const { data, error } = await client.rpc('claim_course_presentation_download_lease', {
    p_actor_id: actorId,
    p_lease_seconds: PRESENTATION_LEASE_SECONDS,
  });
  if (error) throw new Error('PRESENTATION_LEASE_UNAVAILABLE');
  const claim = parseLeaseClaim(data);
  if (!claim) throw new Error('PRESENTATION_LEASE_RESPONSE_INVALID');
  if (!claim.allowed) throw new RateLimitError(claim.retryAfter);
  return claim.leaseId;
}

async function releasePresentationLease(
  client: ServiceRpcClient,
  leaseId: string,
  actorId: string,
) {
  try {
    await client.rpc('release_course_presentation_download_lease', {
      p_actor_id: actorId,
      p_lease_id: leaseId,
    });
  } catch {
    // The bounded lease expires independently if the best-effort release RPC
    // is unavailable after the response has already begun streaming.
  }
}

function assetHeaders(resource: AuthorizedAsset, contentLength?: number) {
  const descriptor = ASSETS[resource.asset];
  const filename = `${resource.slug}${descriptor.filenameSuffix}`;
  const disposition =
    resource.asset === 'presentation'
      ? `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
      : `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const headers = new Headers({
    ...securityHeaders(),
    'Content-Disposition': disposition,
    'Content-Type': descriptor.contentType,
  });
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  return headers;
}

async function serveAsset(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
  headOnly: boolean,
) {
  const authorized = await authorizeAsset(request, context);
  if (authorized instanceof Response) return authorized;

  if (headOnly) {
    return new Response(null, {
      status: 200,
      headers: assetHeaders(
        authorized,
        authorized.asset === 'presentation'
          ? (authorized.presentation.byte_size ?? undefined)
          : undefined,
      ),
    });
  }

  let releaseBeforeReturn: (() => Promise<void>) | null = null;
  try {
    const admin = createAdminClient();
    const { data: record, error: recordError } = await admin
      .from('course_presentations')
      .select('storage_bucket,storage_path,thumbnail_path,status')
      .eq('id', authorized.presentation.presentation_id)
      .maybeSingle();
    if (
      recordError ||
      !record ||
      record.status !== 'ready' ||
      record.storage_bucket !== PRESENTATION_BUCKET
    ) {
      return blockedResponse(404);
    }
    const objectPath =
      authorized.asset === 'presentation' ? record.storage_path : record.thumbnail_path;
    if (!isSafeStoragePath(objectPath)) return blockedResponse(503);

    const ipHash = requestSecurityMetadata(request).ipHash;
    await Promise.all([
      consumeCoarseQuota('presentation.download', ipHash),
      consumeBusinessQuota('presentation.download', authorized.actorId),
    ]);

    const serviceRpc = admin as unknown as ServiceRpcClient;
    const leaseId = await claimPresentationLease(serviceRpc, authorized.actorId);
    let leaseReleased = false;
    const releaseLease = async () => {
      if (leaseReleased) return;
      leaseReleased = true;
      await releasePresentationLease(serviceRpc, leaseId, authorized.actorId);
    };
    releaseBeforeReturn = releaseLease;

    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(PRESENTATION_RELAY_TIMEOUT_MS),
    ]);
    const { data, error } = await admin.storage
      .from(PRESENTATION_BUCKET)
      .download(objectPath, {}, { signal })
      .asStream();
    if (error || !data) return blockedResponse(404);

    const expectedBytes =
      authorized.asset === 'presentation'
        ? (authorized.presentation.byte_size ?? undefined)
        : undefined;
    const stream = createBoundedRelayStream(data as ReadableStream<Uint8Array>, {
      expectedBytes,
      maxBytes: authorized.asset === 'presentation' ? PRESENTATION_MAX_BYTES : THUMBNAIL_MAX_BYTES,
      signal,
      onFinalize: releaseLease,
    });
    const response = new Response(stream, {
      status: 200,
      headers: assetHeaders(authorized, expectedBytes),
    });
    releaseBeforeReturn = null;
    return response;
  } catch (error) {
    if (error instanceof RateLimitError) return blockedResponse(429, error.retryAfter);
    return blockedResponse(503);
  } finally {
    if (releaseBeforeReturn) await releaseBeforeReturn();
  }
}

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
) {
  return serveAsset(request, context, false);
}

export async function HEAD(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
) {
  return serveAsset(request, context, true);
}
