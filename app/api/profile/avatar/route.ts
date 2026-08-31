import { createHash } from 'node:crypto';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { AVATAR_HEIGHT, AVATAR_MAX_BYTES, AVATAR_WIDTH } from '@/lib/avatar-image';
import { validatedStaticWebpDimensions } from '@/lib/security/avatar-webp';
import { normalizeAvatarImage } from '@/lib/security/avatar-decode';
import { consumeBusinessQuota } from '@/lib/security/rate-limit';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

const AVATAR_BUCKET = 'profile-avatars';
const MULTIPART_MAX_BYTES = AVATAR_MAX_BYTES + 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

type RpcError = { message: string; code?: string };
type RpcResponse = PromiseLike<{ data: unknown; error: RpcError | null }>;
type AvatarAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(name: string, args: Record<string, unknown>): RpcResponse;
};
type OperationStatus =
  | 'prepared'
  | 'staged'
  | 'promoting'
  | 'reconcile_required'
  | 'cancel_requested'
  | 'committed'
  | 'aborted';
type Operation = {
  status: OperationStatus;
  operationToken: string;
  objectKey: string | null;
  avatarUpdatedAt?: string;
};
type CommittedOperation = Operation & {
  status: 'committed';
  objectKey: string;
  avatarUpdatedAt: string;
};

class AvatarContractError extends Error {
  constructor(message = 'AVATAR_OPERATION_CONTRACT_BROKEN') {
    super(message);
    this.name = 'AvatarContractError';
  }
}

async function readBoundedBody(request: Request, maximumBytes: number) {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) return null;
    const contentLength = Number(declaredLength);
    if (!Number.isSafeInteger(contentLength) || contentLength > maximumBytes) return null;
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function validObjectKey(value: unknown, userId: string, operationToken: string): value is string {
  // The database owns the exact path. Binding both the user and unguessable
  // operation token here prevents a malformed RPC response becoming an
  // arbitrary service-role Storage write/delete primitive.
  return value === `${userId}/objects/${operationToken}.webp`;
}

function parseBegin(value: unknown, userId: string) {
  const result = record(value);
  const status = result?.status;
  const operationToken = result?.operationToken;
  if (
    !result ||
    !['prepared', 'in_progress', 'reconcile_required'].includes(String(status)) ||
    typeof operationToken !== 'string' ||
    !UUID_PATTERN.test(operationToken) ||
    !validObjectKey(result.objectKey, userId, operationToken) ||
    !validIsoTimestamp(result.expiresAt)
  ) {
    throw new AvatarContractError();
  }
  return {
    status: status as 'prepared' | 'in_progress' | 'reconcile_required',
    operationToken,
    objectKey: result.objectKey,
    expiresAt: result.expiresAt,
  };
}

function parseOperation(value: unknown, userId: string, expectedToken: string): Operation {
  const result = record(value);
  const status = result?.status;
  const operationToken = result?.operationToken;
  if (
    !result ||
    ![
      'prepared',
      'staged',
      'promoting',
      'reconcile_required',
      'cancel_requested',
      'committed',
      'aborted',
    ].includes(String(status)) ||
    operationToken !== expectedToken
  ) {
    throw new AvatarContractError();
  }

  if (status === 'committed') {
    if (
      !validObjectKey(result.objectKey, userId, expectedToken) ||
      !validIsoTimestamp(result.avatarUpdatedAt)
    ) {
      throw new AvatarContractError();
    }
    return {
      status,
      operationToken,
      objectKey: result.objectKey,
      avatarUpdatedAt: result.avatarUpdatedAt,
    };
  }

  if (result.objectKey !== null && !validObjectKey(result.objectKey, userId, expectedToken)) {
    throw new AvatarContractError();
  }
  return {
    status: status as Exclude<OperationStatus, 'committed'>,
    operationToken,
    objectKey: result.objectKey,
  };
}

function parseStaged(value: unknown, userId: string, expectedToken: string) {
  const operation = parseOperation(value, userId, expectedToken);
  if (operation.status !== 'staged' || operation.objectKey === null) {
    throw new AvatarContractError();
  }
  return operation;
}

function parseCommitted(value: unknown, userId: string, expectedToken: string): CommittedOperation {
  const operation = parseOperation(value, userId, expectedToken);
  if (
    operation.status !== 'committed' ||
    operation.objectKey === null ||
    !operation.avatarUpdatedAt
  ) {
    throw new AvatarContractError();
  }
  return operation as CommittedOperation;
}

function parseAbort(value: unknown, userId: string, expectedToken: string) {
  const result = record(value);
  const status = result?.status;
  if (
    !result ||
    !['cancel_requested', 'committed', 'not_found'].includes(String(status)) ||
    result.operationToken !== expectedToken
  ) {
    throw new AvatarContractError();
  }
  if (status === 'cancel_requested') {
    if (!validObjectKey(result.objectKey, userId, expectedToken)) {
      throw new AvatarContractError();
    }
    return { status, operationToken: expectedToken, objectKey: result.objectKey } as const;
  }
  return { status: status as 'committed' | 'not_found', operationToken: expectedToken } as const;
}

async function rpc(admin: AvatarAdminClient, name: string, args: Record<string, unknown>) {
  return unwrapRpcMutationResponse(await admin.rpc(name, args));
}

function errorStatus(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const raw = 'status' in error ? error.status : null;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

function isDefiniteDuplicate(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const status = errorStatus(error);
  const statusCode = 'statusCode' in error ? String(error.statusCode).toLowerCase() : '';
  return status === 409 || statusCode === '409' || statusCode.includes('duplicate');
}

function isDefiniteMissing(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const status = errorStatus(error);
  const statusCode = 'statusCode' in error ? String(error.statusCode).toLowerCase() : '';
  return status === 404 || statusCode === '404' || statusCode.includes('not_found');
}

function mustInspectUploadError(error: unknown) {
  if (isDefiniteDuplicate(error)) return true;
  const status = errorStatus(error);
  return status === null || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function objectMatches(
  admin: AvatarAdminClient,
  objectKey: string,
  expectedSha256: string,
  expectedBytes: number,
) {
  const { data, error } = await admin.storage
    .from(AVATAR_BUCKET)
    .download(objectKey, {}, { cache: 'no-store' });
  if (error) {
    if (isDefiniteMissing(error)) return false;
    throw error;
  }
  if (!data || data.size !== expectedBytes) return false;
  const observedSha256 = createHash('sha256')
    .update(new Uint8Array(await data.arrayBuffer()))
    .digest('hex');
  return observedSha256 === expectedSha256;
}

async function getOperation(admin: AvatarAdminClient, userId: string, operationToken: string) {
  const result = await rpc(admin, 'get_profile_avatar_upload_operation', {
    p_user_id: userId,
    p_operation_token: operationToken,
  });
  return parseOperation(result, userId, operationToken);
}

async function finalizeWithRecovery(
  admin: AvatarAdminClient,
  userId: string,
  operationToken: string,
) {
  const finalize = () =>
    rpc(admin, 'finalize_profile_avatar_upload', {
      p_user_id: userId,
      p_operation_token: operationToken,
    });
  try {
    return parseCommitted(await finalize(), userId, operationToken);
  } catch (firstError) {
    // A transport error can hide a committed DB transaction. Inspect before
    // retrying so the recovery path never compensates a committed avatar.
    const operation = await getOperation(admin, userId, operationToken);
    if (operation.status === 'committed') {
      return operation as CommittedOperation;
    }
    if (!['staged', 'promoting', 'reconcile_required'].includes(operation.status)) {
      throw firstError;
    }
    try {
      return parseCommitted(await finalize(), userId, operationToken);
    } catch (retryError) {
      const retriedOperation = await getOperation(admin, userId, operationToken);
      if (retriedOperation.status === 'committed') {
        return retriedOperation as CommittedOperation;
      }
      throw retryError;
    }
  }
}

async function abortPrecommitOperation(
  admin: AvatarAdminClient,
  userId: string,
  operationToken: string,
  objectKey: string,
  errorCode: string,
) {
  // Cancellation is durable, but removal is intentionally worker-only. A
  // failed/ambiguous Storage response can race a write that the Storage API
  // already accepted; an immediate app-side remove could complete before that
  // late write and leave an orphan. The reconciler waits for the write lease
  // horizon, rechecks the exact immutable key, and only then terminalizes it.
  let abortResult: ReturnType<typeof parseAbort>;
  try {
    abortResult = parseAbort(
      await rpc(admin, 'abort_profile_avatar_upload', {
        p_user_id: userId,
        p_operation_token: operationToken,
        p_error_code: errorCode,
      }),
      userId,
      operationToken,
    );
  } catch {
    console.error('AVATAR_UPLOAD_ABORT_FAILED');
    return;
  }
  if (abortResult.status !== 'cancel_requested' || abortResult.objectKey !== objectKey) {
    console.error('AVATAR_UPLOAD_ABORT_CONTRACT_BROKEN');
  }
}

async function markUploadLeaseFinished(
  admin: AvatarAdminClient,
  userId: string,
  operationToken: string,
  errorCode: string | null,
) {
  try {
    await rpc(admin, 'finish_profile_avatar_storage_write', {
      p_user_id: userId,
      p_operation_token: operationToken,
      p_error_code: errorCode,
    });
  } catch {
    // The durable lease expires independently; reconciliation remains safe
    // after a process crash or an ambiguous completion response.
    console.error('AVATAR_STORAGE_WRITE_LEASE_FINISH_FAILED');
  }
}

export async function POST(request: Request) {
  let cleanup:
    | {
        admin: AvatarAdminClient;
        userId: string;
        operationToken: string;
        objectKey: string;
      }
    | undefined;
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const contentType = request.headers.get('content-type') ?? '';
    if (
      contentType.length > 512 ||
      !/^multipart\/form-data\s*;\s*boundary=(?:[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,70}|"[!#$%&'*+\-.^_`|~()\/:<=>?@\[\]{},0-9A-Za-z ]{1,70}")$/u.test(
        contentType,
      )
    ) {
      return NextResponse.json({ error: 'AVATAR_FORM_REQUIRED' }, { status: 400 });
    }
    const context = await requireUser({ enforceLegal: false });
    await consumeBusinessQuota('avatar.upload', context.user.id);
    const requestBytes = await readBoundedBody(request, MULTIPART_MAX_BYTES);
    if (!requestBytes) {
      return NextResponse.json({ error: 'AVATAR_TOO_LARGE' }, { status: 413 });
    }

    const body = await new Request('http://safetyhub.local/avatar', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: requestBytes,
    })
      .formData()
      .catch(() => null);
    if (!body) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    const avatar = body.get('avatar');
    if (
      !(avatar instanceof File) ||
      (avatar.type !== 'image/webp' && avatar.type !== 'image/jpeg')
    ) {
      return NextResponse.json({ error: 'AVATAR_IMAGE_REQUIRED' }, { status: 400 });
    }
    if (avatar.size <= 0 || avatar.size > AVATAR_MAX_BYTES) {
      return NextResponse.json({ error: 'AVATAR_TOO_LARGE' }, { status: 413 });
    }

    const receivedBytes = new Uint8Array(await avatar.arrayBuffer());
    const bytes = await normalizeAvatarImage(receivedBytes, avatar.type);
    if (!bytes) {
      return NextResponse.json({ error: 'AVATAR_DIMENSIONS_INVALID' }, { status: 400 });
    }
    const dimensions = validatedStaticWebpDimensions(bytes);
    if (
      dimensions?.width !== AVATAR_WIDTH ||
      dimensions.height !== AVATAR_HEIGHT
    ) {
      return NextResponse.json({ error: 'AVATAR_DIMENSIONS_INVALID' }, { status: 400 });
    }

    const expectedSha256 = createHash('sha256').update(bytes).digest('hex');
    if (!SHA256_PATTERN.test(expectedSha256)) throw new AvatarContractError();
    const session = await createClient();
    const admin = createAdminClient() as AvatarAdminClient;
    const begin = parseBegin(
      await rpc(admin, 'begin_profile_avatar_upload', {
        p_user_id: context.user.id,
        p_expected_sha256: expectedSha256,
        p_expected_bytes: bytes.byteLength,
      }),
      context.user.id,
    );
    if (begin.status !== 'prepared') {
      return NextResponse.json({ error: 'AVATAR_UPLOAD_IN_PROGRESS' }, { status: 409 });
    }

    cleanup = {
      admin,
      userId: context.user.id,
      operationToken: begin.operationToken,
      objectKey: begin.objectKey,
    };
    const { data: uploadResult, error: uploadError } = await session.storage
      .from(AVATAR_BUCKET)
      .upload(begin.objectKey, bytes, {
        contentType: 'image/webp',
        cacheControl: '600',
        upsert: false,
      });
    if (uploadError) {
      // 409 is a definite immutable-key collision. Network/5xx failures are
      // ambiguous: the object may have landed despite the lost response. In
      // both cases, an exact download+digest is the only safe way forward.
      if (!mustInspectUploadError(uploadError)) {
        throw uploadError;
      }
      const positivelyVerified = await objectMatches(
        admin,
        begin.objectKey,
        expectedSha256,
        bytes.byteLength,
      );
      if (!positivelyVerified) {
        throw uploadError;
      }
    } else if (uploadResult?.path !== begin.objectKey) {
      // A malformed success response must not clear the durable write lease or
      // publish a manifest for an unproven object.
      throw new AvatarContractError('AVATAR_STORAGE_SUCCESS_CONTRACT_BROKEN');
    }

    await markUploadLeaseFinished(admin, context.user.id, begin.operationToken, null);

    parseStaged(
      await rpc(admin, 'mark_profile_avatar_staged', {
        p_user_id: context.user.id,
        p_operation_token: begin.operationToken,
        p_observed_sha256: expectedSha256,
        p_observed_bytes: bytes.byteLength,
      }),
      context.user.id,
      begin.operationToken,
    );

    const committed = await finalizeWithRecovery(admin, context.user.id, begin.operationToken);
    cleanup = undefined;
    const { data: signed, error: signedError } = await admin.storage
      .from(AVATAR_BUCKET)
      .createSignedUrl(committed.objectKey, 10 * 60);
    if (signedError || !signed?.signedUrl) {
      throw signedError ?? new AvatarContractError('AVATAR_SIGNED_URL_CONTRACT_BROKEN');
    }

    return NextResponse.json({
      avatarUrl: signed.signedUrl,
      avatarUpdatedAt: committed.avatarUpdatedAt,
      bytes: bytes.byteLength,
    });
  } catch (error) {
    if (cleanup) {
      await abortPrecommitOperation(
        cleanup.admin,
        cleanup.userId,
        cleanup.operationToken,
        cleanup.objectKey,
        'APP_PRECOMMIT_FAILURE',
      );
    }
    return apiError(error);
  }
}
