import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { matchesBearerSecret } from '../../lib/security/bearer-secret.ts';

test('content revalidation fails closed for missing and short secrets', () => {
  assert.equal(matchesBearerSecret('Bearer short', undefined), false);
  assert.equal(matchesBearerSecret('Bearer short', 'short'), false);
  assert.equal(matchesBearerSecret(`Bearer ${' '.repeat(32)}`, ' '.repeat(32)), false);
  assert.equal(matchesBearerSecret(`Bearer ${'a'.repeat(31)}`, 'a'.repeat(31)), false);
});

test('content revalidation accepts only the exact >=32-byte bearer secret', () => {
  const secret = 'a-secure-content-revalidate-secret-32+';
  assert.equal(matchesBearerSecret(`Bearer ${secret}`, secret), true);
  assert.equal(matchesBearerSecret(`bearer ${secret}`, secret), false);
  assert.equal(matchesBearerSecret(`Bearer ${secret}x`, secret), false);
  assert.equal(matchesBearerSecret(`Bearer ${'x'.repeat(513)}`, 'x'.repeat(513)), false);
});

test('example and documentation state the revalidation secret minimum', async () => {
  const [example, readme] = await Promise.all([
    readFile(new URL('../../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../../README.md', import.meta.url), 'utf8'),
  ]);
  assert.match(example, /CONTENT_REVALIDATE_SECRET=replace-with-at-least-32-random-characters/);
  assert.match(readme, /`CONTENT_REVALIDATE_SECRET`[^\n]*32/);
});
