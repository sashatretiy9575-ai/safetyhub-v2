import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ClientRequestError,
  classifyClientRequestFailure,
  clientFetch,
  clientRequest,
  clientRequestMessage,
  readClientResponseJson,
} from '../../lib/client-request.ts';

const abortablePendingFetch = (_input, init = {}) =>
  new Promise((_resolve, reject) => {
    const rejectFromAbort = () => reject(init.signal?.reason ?? new Error('aborted'));
    if (init.signal?.aborted) rejectFromAbort();
    else init.signal?.addEventListener('abort', rejectFromAbort, { once: true });
  });

test('successful and HTTP requests always settle as result objects', async () => {
  const success = await clientRequest(
    '/ok',
    {},
    {
      fetch: async () => new Response('{"ok":true}', { status: 200 }),
    },
  );
  assert.equal(success.ok, true);
  assert.equal(success.response.status, 200);

  const failure = await clientRequest(
    '/unavailable',
    {},
    {
      fetch: async () => new Response('unavailable', { status: 503 }),
    },
  );
  assert.equal(failure.ok, false);
  assert.equal(failure.error.kind, 'http');
  assert.equal(failure.error.status, 503);
  assert.equal(failure.error.retryable, true);
  assert.equal(failure.response.status, 503);
});

test('shared application requests always send same-origin cookies and avoid caches', async () => {
  let observed;
  const result = await clientRequest('/protected', {}, {
    fetch: async (_input, init) => {
      observed = init;
      return new Response('{}', { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(observed.credentials, 'same-origin');
  assert.equal(observed.cache, 'no-store');
});

test('network rejections settle and distinguish online from offline', async () => {
  const fetch = async () => {
    throw new TypeError('fetch failed');
  };
  const network = await clientRequest('/network', {}, { fetch, isOnline: () => true });
  const offline = await clientRequest('/offline', {}, { fetch, isOnline: () => false });

  assert.equal(network.ok, false);
  assert.equal(network.error.kind, 'network');
  assert.equal(offline.ok, false);
  assert.equal(offline.error.kind, 'offline');
});

test('the timeout aborts the underlying fetch and settles as timeout', async () => {
  const result = await clientRequest(
    '/slow',
    {},
    {
      fetch: abortablePendingFetch,
      timeoutMs: 5,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'timeout');
  assert.equal(result.error.retryable, true);
  assert.match(clientRequestMessage(result.error, 'fallback'), /вовремя/iu);
});

test('an external signal is combined with the timeout signal', async () => {
  const controller = new AbortController();
  const pending = clientRequest(
    '/cancelled',
    {},
    {
      fetch: abortablePendingFetch,
      signal: controller.signal,
      timeoutMs: 1_000,
    },
  );
  controller.abort(new Error('page closed'));

  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'aborted');
  assert.equal(result.error.retryable, false);
});

test('fetch-compatible wrapper preserves HTTP responses and brands transport failures', async () => {
  const response = await clientFetch(
    '/bad-request',
    {},
    {
      fetch: async () => new Response('bad request', { status: 400 }),
    },
  );
  assert.equal(response.status, 400);

  await assert.rejects(
    clientFetch('/slow', {}, { fetch: abortablePendingFetch, timeoutMs: 5 }),
    (error) =>
      error instanceof ClientRequestError &&
      error.failure.kind === 'timeout' &&
      error.message.includes('CLIENT_REQUEST_TIMEOUT'),
  );
});

test('classification survives an SDK error wrapper', () => {
  const failure = classifyClientRequestFailure({
    name: 'AuthRetryableFetchError',
    status: 0,
    message: 'CLIENT_REQUEST_TIMEOUT: Client request timed out',
  });
  assert.equal(failure.kind, 'timeout');
});

test('user messages distinguish rate limits, server failures, timeout, and offline', () => {
  assert.match(
    clientRequestMessage({ status: 429, message: 'rate limited' }, 'fallback'),
    /много/iu,
  );
  assert.match(
    clientRequestMessage({ status: 503, message: 'unavailable' }, 'fallback'),
    /временно/iu,
  );
  assert.match(
    clientRequestMessage({ message: 'CLIENT_REQUEST_TIMEOUT: timeout' }, 'fallback'),
    /вовремя/iu,
  );
  assert.match(clientRequestMessage({ message: 'fetch failed' }, 'fallback'), /связаться/iu);
  assert.match(
    clientRequestMessage({ message: 'CLIENT_REQUEST_OFFLINE: fetch failed' }, 'fallback'),
    /сеть/iu,
  );
});

test('response JSON parsing is also bounded and always settled', async () => {
  const response = {
    json: () => new Promise(() => {}),
  };
  assert.equal(await readClientResponseJson(response, 5), null);
});
