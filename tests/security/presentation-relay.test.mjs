import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createBoundedRelayStream } from '../../lib/security/bounded-relay-stream.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function byteStream(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Uint8Array.from(chunk));
      controller.close();
    },
  });
}

async function collect(stream) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test('bounded presentation relay streams exact bytes and finalizes its lease once', async () => {
  const reasons = [];
  const relay = createBoundedRelayStream(
    byteStream([
      [1, 2],
      [3, 4],
    ]),
    {
      expectedBytes: 4,
      maxBytes: 4,
      signal: new AbortController().signal,
      onFinalize: async (reason) => reasons.push(reason),
    },
  );

  assert.deepEqual([...(await collect(relay))], [1, 2, 3, 4]);
  assert.deepEqual(reasons, ['complete']);
});

test('bounded presentation relay rejects short and oversized upstream bodies', async () => {
  for (const scenario of [
    { chunks: [[1, 2]], expectedBytes: 3 },
    {
      chunks: [
        [1, 2],
        [3, 4],
      ],
      expectedBytes: 3,
    },
  ]) {
    const reasons = [];
    const relay = createBoundedRelayStream(byteStream(scenario.chunks), {
      expectedBytes: scenario.expectedBytes,
      maxBytes: 3,
      signal: new AbortController().signal,
      onFinalize: (reason) => reasons.push(reason),
    });
    await assert.rejects(collect(relay), /PRESENTATION_STREAM_SIZE_MISMATCH/);
    assert.deepEqual(reasons, ['size-mismatch']);
  }
});

test('bounded presentation relay propagates cancellation and abort cleanup exactly once', async () => {
  const cancellationReasons = [];
  const cancellable = createBoundedRelayStream(byteStream([[1], [2]]), {
    maxBytes: 2,
    signal: new AbortController().signal,
    onFinalize: (reason) => cancellationReasons.push(reason),
  });
  await cancellable.cancel('client disconnected');
  assert.deepEqual(cancellationReasons, ['cancelled']);

  const abortController = new AbortController();
  const abortReasons = [];
  const pending = new ReadableStream({
    pull() {
      return new Promise(() => undefined);
    },
  });
  const aborted = createBoundedRelayStream(pending, {
    maxBytes: 2,
    signal: abortController.signal,
    onFinalize: (reason) => abortReasons.push(reason),
  });
  const reader = aborted.getReader();
  const readResult = reader.read();
  abortController.abort(new Error('deadline'));
  await assert.rejects(readResult, /PRESENTATION_STREAM_ABORTED/);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(abortReasons, ['aborted']);
});

test('private presentation GET is quota-, lease-, deadline-, and stream-bounded while HEAD is metadata-only', async () => {
  const [route, rateLimit] = await Promise.all([
    read('app/course-presentations/[slug]/[asset]/route.ts'),
    read('lib/security/rate-limit.ts'),
  ]);

  assert.match(route, /consumeCoarseQuota\('presentation\.download', ipHash\)/);
  assert.match(route, /consumeBusinessQuota\('presentation\.download', authorized\.actorId\)/);
  assert.match(route, /claim_course_presentation_download_lease/);
  assert.match(route, /release_course_presentation_download_lease/);
  assert.match(route, /PRESENTATION_LEASE_SECONDS = 90/);
  assert.match(route, /PRESENTATION_RELAY_TIMEOUT_MS = 60_000/);
  assert.match(route, /AbortSignal\.any/);
  assert.match(route, /AbortSignal\.timeout\(PRESENTATION_RELAY_TIMEOUT_MS\)/);
  assert.match(route, /\.download\(objectPath, \{\}, \{ signal \}\)[\s\S]*?\.asStream\(\)/);
  assert.match(route, /createBoundedRelayStream/);
  assert.match(route, /status === 429[\s\S]*?'Retry-After'/);
  assert.doesNotMatch(route, /\.arrayBuffer\(\)|data\.size|data\.stream\(\)/);
  assert.ok(
    route.indexOf('if (headOnly)') < route.indexOf("consumeCoarseQuota('presentation.download'"),
    'HEAD must return before quotas, leases, and Storage transfer',
  );
  assert.match(rateLimit, /\| 'presentation\.download'/);
});
