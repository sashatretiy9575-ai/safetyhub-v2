import 'server-only';

const DEFAULT_CONTENT_DEADLINE_MS = 4_000;
const MIN_CONTENT_DEADLINE_MS = 1_000;
const MAX_CONTENT_DEADLINE_MS = 10_000;
// `next build` renders every page against the database in Mumbai from Vercel's
// build machines, many requests at once. The visitor budget above failed whole
// production releases there (twice on 13 September 2026); no visitor waits on a
// build, so it gets a longer deadline.
const BUILD_CONTENT_DEADLINE_MS = 15_000;

export class ContentUpstreamTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor(readonly deadlineMs: number) {
    super(`Content upstream exceeded ${deadlineMs}ms deadline`);
    this.name = 'TimeoutError';
  }
}

export function contentUpstreamDeadlineMs(
  value = process.env.CONTENT_UPSTREAM_TIMEOUT_MS,
  phase = process.env.NEXT_PHASE,
) {
  const parsed = Number(value);
  const deadline = Number.isFinite(parsed)
    ? Math.min(MAX_CONTENT_DEADLINE_MS, Math.max(MIN_CONTENT_DEADLINE_MS, parsed))
    : DEFAULT_CONTENT_DEADLINE_MS;
  return phase === 'phase-production-build'
    ? Math.max(deadline, BUILD_CONTENT_DEADLINE_MS)
    : deadline;
}

export async function contentUpstreamFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const deadlineMs = contentUpstreamDeadlineMs();
  const deadlineController = new AbortController();
  const timeout = setTimeout(
    () => deadlineController.abort(new ContentUpstreamTimeoutError(deadlineMs)),
    deadlineMs,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, deadlineController.signal])
    : deadlineController.signal;

  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (deadlineController.signal.aborted && !init.signal?.aborted) {
      throw deadlineController.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
