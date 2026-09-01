const TRANSPORT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSPORT_ERROR_NAMES = new Set(['AbortError', 'FetchError', 'NetworkError', 'TimeoutError']);

type ContentFailureInput = {
  configured: boolean;
  error?: unknown;
  status?: number;
  fallbackEnabled?: boolean;
};

export type ContentFailureDecision =
  | { action: 'remote' }
  | { action: 'fallback'; reason: 'unconfigured' | 'transport' }
  | { action: 'throw'; reason: 'backend' | 'transport-disabled' };

/**
 * CONTENT_FALLBACK_ENABLED=true is an explicit degraded-mode switch. It permits
 * bundled JSON only for classified transport failures; HTTP/PostgREST errors
 * still surface so an unpublished item can never reappear from the bundle.
 */
export function isContentFallbackEnabled(
  value: string | undefined = process.env.CONTENT_FALLBACK_ENABLED,
): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/**
 * Bundled content snapshots are Russian source material. A localized route
 * must fail closed instead of presenting that Russian fallback as another
 * language when the public content source is unavailable.
 */
export function fallbackForUnavailableLocalizedContent<T>(
  locale: string,
  ruFallback: () => T,
  unavailable: () => T,
): T {
  return locale === 'ru' ? ruFallback() : unavailable();
}

function errorRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null;
}

export function isContentTransportError(error: unknown, status?: number): boolean {
  if (status === 0) return true;

  const record = errorRecord(error);
  const name = error instanceof Error ? error.name : record?.name;
  if (typeof name === 'string' && TRANSPORT_ERROR_NAMES.has(name)) return true;

  const code = record?.code;
  if (
    typeof code === 'string' &&
    (TRANSPORT_ERROR_CODES.has(code.toUpperCase()) ||
      code === '42703' ||
      code === 'PGRST200' ||
      code === 'PGRST204')
  )
    return true;

  if (
    error instanceof TypeError &&
    /(?:fetch failed|failed to fetch|networkerror)/iu.test(error.message)
  ) {
    return true;
  }

  const cause = error instanceof Error ? error.cause : record?.cause;
  return cause !== undefined && cause !== error ? isContentTransportError(cause) : false;
}

export function classifyContentFailure({
  configured,
  error,
  status,
  fallbackEnabled = isContentFallbackEnabled(),
}: ContentFailureInput): ContentFailureDecision {
  if (!configured) return { action: 'fallback', reason: 'unconfigured' };
  if (error === undefined || error === null) return { action: 'remote' };

  const record = errorRecord(error);
  const code = record?.code;
  if (code === '42703' || code === 'PGRST200' || code === 'PGRST204') {
    return { action: 'fallback', reason: 'unconfigured' };
  }

  if (isContentTransportError(error, status)) {
    return fallbackEnabled
      ? { action: 'fallback', reason: 'transport' }
      : { action: 'throw', reason: 'transport-disabled' };
  }

  return { action: 'throw', reason: 'backend' };
}

export class ContentSourceError extends Error {
  readonly failure: 'backend' | 'transport-disabled';
  readonly operation: string;
  readonly status?: number;

  constructor({
    failure,
    operation,
    error,
    status,
  }: {
    failure: 'backend' | 'transport-disabled';
    operation: string;
    error: unknown;
    status?: number;
  }) {
    super(`Content source failed during ${operation}`, { cause: error });
    this.name = 'ContentSourceError';
    this.failure = failure;
    this.operation = operation;
    this.status = status;
  }
}

function errorCode(error: unknown): string | undefined {
  const code = errorRecord(error)?.code;
  return typeof code === 'string' && code ? code : undefined;
}

export function fallbackAfterContentFailure<T>({
  configured,
  error,
  fallback,
  operation,
  status,
}: ContentFailureInput & {
  fallback: () => T;
  operation: string;
}): T {
  const decision = classifyContentFailure({ configured, error, status });

  if (decision.action === 'fallback') {
    if (decision.reason === 'transport') {
      console.warn('CONTENT_FALLBACK_ACTIVE', {
        code: errorCode(error),
        operation,
        reason: decision.reason,
        status,
      });
    }
    return fallback();
  }

  if (decision.action === 'throw') {
    throw new ContentSourceError({
      error,
      failure: decision.reason,
      operation,
      status,
    });
  }

  throw new Error('fallbackAfterContentFailure requires a content source failure');
}
