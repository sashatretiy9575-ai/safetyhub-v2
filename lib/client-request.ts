export const DEFAULT_CLIENT_REQUEST_TIMEOUT_MS = 15_000;

export type ClientRequestFailureKind = 'offline' | 'timeout' | 'http' | 'network' | 'aborted';

export type ClientRequestFailure = Readonly<{
  kind: ClientRequestFailureKind;
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}>;

export type ClientRequestResult =
  | Readonly<{ ok: true; response: Response }>
  | Readonly<{ ok: false; error: ClientRequestFailure; response?: Response }>;

export type ClientRequestOptions = Readonly<{
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  isOnline?: () => boolean;
}>;

const FAILURE_CODES: Record<ClientRequestFailureKind, string> = {
  offline: 'CLIENT_REQUEST_OFFLINE',
  timeout: 'CLIENT_REQUEST_TIMEOUT',
  http: 'CLIENT_REQUEST_HTTP',
  network: 'CLIENT_REQUEST_NETWORK',
  aborted: 'CLIENT_REQUEST_ABORTED',
};

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return typeof error === 'string' ? error : 'Unknown request failure';
}

function errorStatus(error: unknown) {
  if (typeof error !== 'object' || !error || !('status' in error)) return undefined;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) && status > 0 ? status : undefined;
}

function defaultIsOnline() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function requestFailure(
  kind: ClientRequestFailureKind,
  message: string,
  options: { status?: number; cause?: unknown } = {},
): ClientRequestFailure {
  return {
    kind,
    message,
    retryable:
      kind === 'offline' ||
      kind === 'timeout' ||
      kind === 'network' ||
      (kind === 'http' &&
        options.status !== undefined &&
        (options.status === 408 ||
          options.status === 425 ||
          options.status === 429 ||
          options.status >= 500)),
    ...(options.status === undefined ? {} : { status: options.status }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  };
}

export class ClientRequestError extends Error {
  readonly failure: ClientRequestFailure;

  constructor(failure: ClientRequestFailure) {
    super(`${FAILURE_CODES[failure.kind]}: ${failure.message}`, {
      cause: failure.cause,
    });
    this.name = 'ClientRequestError';
    this.failure = failure;
  }
}

export function classifyClientRequestFailure(
  error: unknown,
  isOnline: () => boolean = defaultIsOnline,
): ClientRequestFailure {
  if (error instanceof ClientRequestError) return error.failure;
  if (
    typeof error === 'object' &&
    error &&
    'kind' in error &&
    typeof error.kind === 'string' &&
    Object.hasOwn(FAILURE_CODES, error.kind) &&
    'message' in error &&
    typeof error.message === 'string' &&
    'retryable' in error &&
    typeof error.retryable === 'boolean'
  ) {
    return error as ClientRequestFailure;
  }

  const message = errorMessage(error);
  for (const [kind, code] of Object.entries(FAILURE_CODES) as [
    ClientRequestFailureKind,
    string,
  ][]) {
    if (message.includes(code)) return requestFailure(kind, message, { cause: error });
  }

  const status = errorStatus(error);
  if (status !== undefined) {
    return requestFailure('http', message, { status, cause: error });
  }
  if (!isOnline()) return requestFailure('offline', message, { cause: error });
  if (typeof error === 'object' && error && 'name' in error && error.name === 'AbortError') {
    return requestFailure('aborted', message, { cause: error });
  }
  return requestFailure('network', message, { cause: error });
}

export function clientRequestMessage(error: unknown, fallback: string) {
  const failure = classifyClientRequestFailure(error);
  switch (failure.kind) {
    case 'offline':
      return 'Нет подключения к интернету. Проверьте сеть и повторите.';
    case 'timeout':
      return 'Сервер не ответил вовремя. Повторите запрос.';
    case 'network':
      return 'Не удалось связаться с сервером. Проверьте сеть и повторите.';
    case 'aborted':
      return 'Запрос отменён. Повторите попытку.';
    case 'http':
      if (failure.status === 429) return 'Слишком много запросов. Попробуйте немного позже.';
      if (failure.retryable) return 'Сервис временно недоступен. Повторите запрос позже.';
      return fallback;
  }
}

export function isClientTransportFailure(error: unknown) {
  const kind = classifyClientRequestFailure(error).kind;
  return kind === 'offline' || kind === 'timeout' || kind === 'network' || kind === 'aborted';
}

export async function readClientResponseJson<T>(
  response: Response | undefined,
  timeoutMs: number = DEFAULT_CLIENT_REQUEST_TIMEOUT_MS,
): Promise<T | null> {
  if (!response) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.json() as Promise<T>,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), normalizedTimeout(timeoutMs));
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizedTimeout(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) return DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;
  return Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_CLIENT_REQUEST_TIMEOUT_MS;
}

export async function clientRequest(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ClientRequestOptions = {},
): Promise<ClientRequestResult> {
  const controller = new AbortController();
  const signals = [...new Set([init.signal, options.signal].filter(Boolean) as AbortSignal[])];
  const removers: Array<() => void> = [];
  let abortKind: 'timeout' | 'external' | null = null;

  const abortFrom = (signal: AbortSignal) => {
    if (controller.signal.aborted) return;
    abortKind = 'external';
    controller.abort(signal.reason);
  };

  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    const listener = () => abortFrom(signal);
    signal.addEventListener('abort', listener, { once: true });
    removers.push(() => signal.removeEventListener('abort', listener));
  }

  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    abortKind = 'timeout';
    controller.abort(new DOMException('Client request timed out', 'TimeoutError'));
  }, normalizedTimeout(options.timeoutMs));

  try {
    const response = await (options.fetch ?? globalThis.fetch)(input, {
      ...init,
      // Every application request is same-origin and authenticated by
      // HttpOnly cookies. Never let a future caller silently omit them.
      credentials: 'same-origin',
      cache: init.cache ?? 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        response,
        error: requestFailure('http', `HTTP ${response.status}`, { status: response.status }),
      };
    }
    return { ok: true, response };
  } catch (error) {
    if (abortKind === 'timeout') {
      return {
        ok: false,
        error: requestFailure('timeout', 'Client request timed out', { cause: error }),
      };
    }
    if (abortKind === 'external') {
      return {
        ok: false,
        error: requestFailure('aborted', 'Client request was aborted', { cause: error }),
      };
    }
    if (!(options.isOnline ?? defaultIsOnline)()) {
      return {
        ok: false,
        error: requestFailure('offline', errorMessage(error), { cause: error }),
      };
    }
    return {
      ok: false,
      error: requestFailure('network', errorMessage(error), { cause: error }),
    };
  } finally {
    clearTimeout(timeout);
    for (const remove of removers) remove();
  }
}

export async function clientFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: ClientRequestOptions = {},
) {
  const result = await clientRequest(input, init, options);
  if (result.ok) return result.response;
  if (result.response) return result.response;
  throw new ClientRequestError(result.error);
}
