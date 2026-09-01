export type BoundedRelayFinalReason =
  | 'complete'
  | 'cancelled'
  | 'aborted'
  | 'size-mismatch'
  | 'upstream-error';

type BoundedRelayOptions = {
  expectedBytes?: number;
  maxBytes: number;
  signal: AbortSignal;
  onFinalize: (reason: BoundedRelayFinalReason) => Promise<void> | void;
};

function streamError(code: string) {
  const error = new Error(code);
  error.name = 'BoundedRelayError';
  return error;
}

/**
 * Relays an upstream byte stream without buffering it in the application
 * process. The wrapper enforces a hard byte ceiling (and, for PDFs, the exact
 * immutable catalog size) before releasing the shared download lease.
 */
export function createBoundedRelayStream(
  upstream: ReadableStream<Uint8Array>,
  options: BoundedRelayOptions,
) {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new Error('PRESENTATION_STREAM_LIMIT_INVALID');
  }
  if (
    options.expectedBytes !== undefined &&
    (!Number.isSafeInteger(options.expectedBytes) ||
      options.expectedBytes < 1 ||
      options.expectedBytes > options.maxBytes)
  ) {
    throw new Error('PRESENTATION_STREAM_EXPECTED_SIZE_INVALID');
  }

  const reader = upstream.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bytesRead = 0;
  let finalized = false;
  let reading = false;

  const finalize = async (reason: BoundedRelayFinalReason) => {
    if (finalized) return;
    finalized = true;
    options.signal.removeEventListener('abort', abortRelay);
    try {
      await options.onFinalize(reason);
    } catch {
      // A database lease is self-expiring. Cleanup failure must not turn a
      // successfully transferred private asset into a client-visible failure.
    }
  };

  const abortRelay = () => {
    if (finalized) return;
    void reader.cancel(options.signal.reason).catch(() => undefined);
    void finalize('aborted');
    try {
      controller?.error(streamError('PRESENTATION_STREAM_ABORTED'));
    } catch {
      // The consumer may already have cancelled or closed the stream.
    }
  };

  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (options.signal.aborted) {
        abortRelay();
        return;
      }
      options.signal.addEventListener('abort', abortRelay, { once: true });
    },
    async pull(streamController) {
      if (finalized || reading) return;
      if (options.signal.aborted) {
        abortRelay();
        return;
      }

      reading = true;
      try {
        const { value, done } = await reader.read();
        if (finalized) return;
        if (done) {
          if (options.expectedBytes !== undefined && bytesRead !== options.expectedBytes) {
            await finalize('size-mismatch');
            streamController.error(streamError('PRESENTATION_STREAM_SIZE_MISMATCH'));
            return;
          }
          await finalize('complete');
          streamController.close();
          return;
        }

        if (!(value instanceof Uint8Array) || value.byteLength < 1) {
          await reader.cancel().catch(() => undefined);
          await finalize('upstream-error');
          streamController.error(streamError('PRESENTATION_STREAM_CHUNK_INVALID'));
          return;
        }

        bytesRead += value.byteLength;
        if (bytesRead > options.maxBytes || bytesRead > (options.expectedBytes ?? Infinity)) {
          await reader.cancel().catch(() => undefined);
          await finalize('size-mismatch');
          streamController.error(streamError('PRESENTATION_STREAM_SIZE_MISMATCH'));
          return;
        }
        streamController.enqueue(value);
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        await finalize(options.signal.aborted ? 'aborted' : 'upstream-error');
        streamController.error(error);
      } finally {
        reading = false;
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await finalize(options.signal.aborted ? 'aborted' : 'cancelled');
    },
  });
}
