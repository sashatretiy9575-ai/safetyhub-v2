import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ADMIN_ATTESTATION_BULK_LIMIT } from '../../lib/constants.ts';
import { readBoundedBytes, readBoundedText } from '../../lib/security/request-body.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function chunkedRequest(bytes, headers = {}) {
  // A chunked body has no Content-Length. The declared value is a client hint
  // in any case, which is exactly why several routes used to trust it.
  return new Request('http://safetyhub.local/probe', {
    method: 'POST',
    headers,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    duplex: 'half',
  });
}

test('a body without Content-Length is still capped by the bytes read', async () => {
  const payload = new Uint8Array(4_096).fill(65);
  await assert.rejects(
    () => readBoundedBytes(chunkedRequest(payload), 1_024),
    /PAYLOAD_TOO_LARGE/u,
  );
  const accepted = await readBoundedBytes(chunkedRequest(payload), 8_192);
  assert.equal(accepted.byteLength, 4_096);
});

test('an understated Content-Length does not raise the cap', async () => {
  const payload = new Uint8Array(4_096).fill(66);
  await assert.rejects(
    () => readBoundedBytes(chunkedRequest(payload, { 'content-length': '10' }), 1_024),
    /PAYLOAD_TOO_LARGE/u,
  );
});

test('readBoundedText refuses a body that is not valid UTF-8', async () => {
  const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
  await assert.rejects(() => readBoundedText(chunkedRequest(invalid), 1_024), /INVALID_JSON/u);
  const text = await readBoundedText(chunkedRequest(new TextEncoder().encode('{"a":1}')), 1_024);
  assert.equal(text, '{"a":1}');
});

test('the send-email hook reads its body through the cap before verifying', async () => {
  const route = await read('app/api/auth/send-email/route.ts');
  const verifyAt = route.indexOf('verifyStandardWebhook({');
  const readAt = route.indexOf('readBoundedText(request, HOOK_BODY_MAX_BYTES)');
  assert.ok(readAt > 0 && verifyAt > readAt, 'the body must be bounded before the signature check');
});

test('the media upload trusts the bytes it reads, not the declared length', async () => {
  const route = await read('app/api/admin/content-assets/route.ts');
  assert.match(route, /readBoundedBytes\(request, SOURCE_MAX_BYTES \+ MULTIPART_OVERHEAD_BYTES\)/u);
  assert.doesNotMatch(route, /Number\(request\.headers\.get\('content-length'\)/u);
  // A boundary must be present and well formed before any body is read.
  assert.match(route, /multipart\\\/form-data/u);
});

test('deduplication does not hand back an asset that is being deleted', async () => {
  const route = await read('app/api/admin/content-assets/route.ts');
  assert.match(route, /existing\.data && existing\.data\.status === 'active'/u);
  assert.match(route, /reviveContentAsset\(/u);
  assert.match(route, /\.in\('status', \['orphan_candidate', 'delete_pending'\]\)/u);
  assert.match(route, /CONTENT_ASSET_STATUS_CHANGED/u);
});

test('a filter matching more rows than one operation may carry answers 409', async () => {
  const [route, manager] = await Promise.all([
    read('app/api/admin/attestations/selection/route.ts'),
    read('components/admin/attestations-manager.tsx'),
  ]);
  assert.match(route, /ATTESTATION_SELECTION_TOO_LARGE/u);
  assert.match(route, /status: 409/u);
  // Reported as a server fault, the operator had no way to know the filter was
  // simply too broad.
  assert.doesNotMatch(route, /SERVER_ERROR/u);
  assert.equal(ADMIN_ATTESTATION_BULK_LIMIT, 500);
  assert.match(manager, /ADMIN_ATTESTATION_BULK_LIMIT/u);
  assert.doesNotMatch(manager, /page\.total > 500/u);
});

test('a bulk profile edit is bounded by the column it writes to', async () => {
  const [route, panels] = await Promise.all([
    read('app/api/admin/attestations/actions/route.ts'),
    read('components/admin/attestations-manager-panels.tsx'),
  ]);
  assert.match(route, /PROFILE_FIELD_LIMITS\[update\.field\]/u);
  assert.doesNotMatch(route, /value: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(200\)/u);
  assert.match(panels, /attestationFieldMaxLengths/u);
  assert.match(panels, /name: 80/u);
  assert.match(panels, /job: 160/u);
});
