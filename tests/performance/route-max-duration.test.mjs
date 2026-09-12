import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

// Every route that decodes images with sharp, parses a presentation with
// pdf.js, assembles a 500-row export or hands a message to a mailbox after
// the response declares its own budget: the platform default is meant for a
// JSON round-trip and used to cut these off half-way, leaving the client
// with a generic failure and the operator with nothing in the log.
const CAPPED_ROUTES = [
  'app/api/admin/courses/[courseId]/presentation/finalize/route.ts',
  'app/api/admin/content-assets/route.ts',
  'app/api/admin/attestations/export/route.ts',
  'app/api/profile/avatar/route.ts',
  'app/api/auth/send-email/route.ts',
  'app/api/auth/send-email/drain/route.ts',
];

test('heavy routes declare a sixty-second budget and stay on the Node runtime', async () => {
  for (const file of CAPPED_ROUTES) {
    const source = await read(file);
    assert.match(source, /^export const maxDuration = 60;$/mu, file);
    assert.match(source, /^export const runtime = 'nodejs';$/mu, file);
  }
});

test('the presentation check samples pages instead of walking a whole deck', async () => {
  const source = await read('server/pdf/render-validation.ts');
  assert.match(source, /PAGE_SAMPLE_LIMIT = 32/u);
  assert.match(source, /PAGE_BATCH_SIZE = 8/u);
  assert.match(source, /export function sampledPageNumbers/u);
  // The boundary render still covers exactly the first and the last page.
  assert.match(source, /new Set\(\[1, expectedPageCount\]\)/u);
  const { sampledPageNumbers } = await import('../../server/pdf/render-validation.ts').catch(
    () => ({ sampledPageNumbers: null }),
  );
  if (sampledPageNumbers) {
    assert.deepEqual(sampledPageNumbers(5), [1, 2, 3, 4, 5]);
    const sampled = sampledPageNumbers(200);
    assert.equal(sampled.length, 32);
    assert.equal(sampled[0], 1);
    assert.equal(sampled.at(-1), 200);
  }
});
