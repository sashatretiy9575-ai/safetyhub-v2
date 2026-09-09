export const DEFAULT_JSON_BODY_MAX_BYTES = 64 * 1024;

export class RequestBodyError extends Error {
  readonly code: 'INVALID_CONTENT_TYPE' | 'INVALID_JSON' | 'PAYLOAD_TOO_LARGE';
  readonly status: 400 | 413;

  constructor(
    code: 'INVALID_CONTENT_TYPE' | 'INVALID_JSON' | 'PAYLOAD_TOO_LARGE',
    status: 400 | 413,
  ) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function contentLength(request: Request) {
  const raw = request.headers.get('content-length');
  if (raw === null) return null;
  if (!/^\d+$/u.test(raw)) throw new RequestBodyError('INVALID_JSON', 400);
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) throw new RequestBodyError('PAYLOAD_TOO_LARGE', 413);
  return length;
}

async function boundedBytes(request: Request, maximumBytes: number) {
  const declared = contentLength(request);
  if (declared !== null && declared > maximumBytes) {
    throw new RequestBodyError('PAYLOAD_TOO_LARGE', 413);
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyError('PAYLOAD_TOO_LARGE', 413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Reads raw bytes through an absolute cap, including chunked requests whose
 * `Content-Length` is absent or lying. Callers that must inspect the exact
 * bytes — a webhook signature covers the body verbatim — use this instead of
 * `request.text()`, which buffers whatever the client sends.
 */
export async function readBoundedBytes(request: Request, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > 8 * 1024 * 1024) {
    throw new Error('BODY_LIMIT_INVALID');
  }
  return boundedBytes(request, maximumBytes);
}

/** Reads a UTF-8 body through an absolute byte cap. */
export async function readBoundedText(request: Request, maximumBytes: number) {
  const bytes = await readBoundedBytes(request, maximumBytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError('INVALID_JSON', 400);
  }
}

/** Reads JSON through an absolute byte cap, including chunked requests. */
export async function readJsonBody(
  request: Request,
  maximumBytes = DEFAULT_JSON_BODY_MAX_BYTES,
): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 2 || maximumBytes > 1024 * 1024) {
    throw new Error('JSON_BODY_LIMIT_INVALID');
  }
  const type = request.headers.get('content-type') ?? '';
  const encoding = request.headers.get('content-encoding')?.trim().toLowerCase();
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type.trim())) {
    throw new RequestBodyError('INVALID_CONTENT_TYPE', 400);
  }
  if (encoding && encoding !== 'identity') {
    throw new RequestBodyError('INVALID_CONTENT_TYPE', 400);
  }

  const bytes = await boundedBytes(request, maximumBytes);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new RequestBodyError('INVALID_JSON', 400);
  }
}
