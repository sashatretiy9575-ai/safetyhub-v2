import 'server-only';

import { normalizeRateLimitError } from '@/lib/security/rate-limit';

const RPC_ERROR_KEY = '__safetyhubRpcError';
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const MESSAGE_PATTERN = /^[A-Z][A-Z0-9_]{1,95}(?::[0-9]{1,10})?$/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

export class RpcMutationError extends Error {
  readonly hint = null;

  constructor(
    public readonly code: string,
    message: string,
    public readonly details: string | null = null,
  ) {
    super(message);
    this.name = 'RpcMutationError';
  }
}

export function getRpcMutationError(value: unknown): RpcMutationError | null {
  const envelope = record(value);
  if (!envelope || !Object.prototype.hasOwnProperty.call(envelope, RPC_ERROR_KEY)) return null;

  const payload = record(envelope[RPC_ERROR_KEY]);
  const code = payload && typeof payload.code === 'string' ? payload.code : '';
  const message = payload && typeof payload.message === 'string' ? payload.message : '';
  const keys = payload ? Object.keys(payload).sort() : [];
  const allowedKeys = ['code', 'message', 'version'];
  let details: string | null = null;
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'details')) {
    allowedKeys.push('details');
    const detail = record(payload.details);
    const retryAt = detail && typeof detail.retryAt === 'string' ? detail.retryAt : '';
    const parsedRetryAt = Date.parse(retryAt);
    const isAttemptLimit =
      code === '54000' &&
      (message === 'ATTEMPT_ROLLING_LIMIT' || message === 'ATTEMPT_DAILY_LIMIT');
    if (
      !isAttemptLimit ||
      !detail ||
      Object.keys(detail).length !== 1 ||
      retryAt.length > 64 ||
      !ISO_TIMESTAMP_PATTERN.test(retryAt) ||
      !Number.isFinite(parsedRetryAt)
    ) {
      return new RpcMutationError('P0001', 'RPC_MUTATION_FAILED');
    }
    details = JSON.stringify({ retryAt: new Date(parsedRetryAt).toISOString() });
  }
  if (
    payload?.version !== 1 ||
    !SQLSTATE_PATTERN.test(code) ||
    !MESSAGE_PATTERN.test(message) ||
    keys.join('\0') !== allowedKeys.sort().join('\0')
  ) {
    return new RpcMutationError('P0001', 'RPC_MUTATION_FAILED');
  }
  return new RpcMutationError(code, message, details);
}

export function unwrapRpcMutationResult<T>(value: T): T {
  const error = getRpcMutationError(value);
  if (error) throw error;
  return value;
}

export function unwrapRpcMutationResponse<T>(response: {
  data: T;
  error: { message: string; code?: string } | null;
}): T {
  if (response.error) normalizeRateLimitError(response.error);
  return unwrapRpcMutationResult(response.data);
}
