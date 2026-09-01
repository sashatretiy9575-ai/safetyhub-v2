import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('repository security gate recognizes GitHub, Telegram, Supabase, and private-key credentials', async () => {
  const source = await readFile(
    new URL('../../scripts/check-security-baseline.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /gh\[pousr\]_/u);
  assert.match(source, /github_pat_/u);
  assert.match(source, /sb_secret_/u);
  assert.match(source, /\[0-9\]\{6,12\}:\[A-Za-z0-9_-\]\{30,/u);
  assert.ok(source.includes('PRIVATE KEY-----'));
});
