import assert from 'node:assert/strict';
import test from 'node:test';
import { readJsonBody, RequestBodyError } from '../../lib/security/request-body.ts';

test('bounded JSON accepts valid UTF-8 JSON and rejects malformed or wrong content types', async () => {
  const valid = new Request('https://safetyhub.kz/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ value: 'Әділ' }),
  });
  assert.deepEqual(await readJsonBody(valid, 256), { value: 'Әділ' });

  await assert.rejects(
    readJsonBody(
      new Request('https://safetyhub.kz/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{}',
      }),
      256,
    ),
    (error) => error instanceof RequestBodyError && error.status === 400,
  );
});

test('declared and chunked bodies are rejected before exceeding the hard cap', async () => {
  await assert.rejects(
    readJsonBody(
      new Request('https://safetyhub.kz/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' },
        body: '{}',
      }),
      32,
    ),
    (error) => error instanceof RequestBodyError && error.code === 'PAYLOAD_TOO_LARGE',
  );

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"value":"'));
      controller.enqueue(new Uint8Array(64));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  await assert.rejects(
    readJsonBody(
      new Request('https://safetyhub.kz/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: stream,
        duplex: 'half',
      }),
      32,
    ),
    (error) => error instanceof RequestBodyError && error.status === 413,
  );
});

test('compressed request bodies are rejected instead of being decompressed implicitly', async () => {
  await assert.rejects(
    readJsonBody(
      new Request('https://safetyhub.kz/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
        body: '{}',
      }),
      256,
    ),
    (error) => error instanceof RequestBodyError && error.code === 'INVALID_CONTENT_TYPE',
  );
});
