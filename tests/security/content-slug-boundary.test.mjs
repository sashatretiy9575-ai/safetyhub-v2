import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isContentSlug } from '../../lib/content/slug.ts';

test('content slugs cannot traverse local fallback directories or amplify cache keys', () => {
  for (const value of [
    '../articles/private',
    '..%2farticles%2fprivate',
    'fire/safety',
    'fire\\safety',
    '.hidden',
    'A'.repeat(121),
  ]) {
    assert.equal(isContentSlug(value), false, value);
  }
  assert.equal(isContentSlug('industrial-safety-2026'), true);
});

test('article and topic lookups validate before entering unstable cache or filesystem fallback', async () => {
  for (const file of ['lib/content/articles.ts', 'lib/content/topics.ts']) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /isContentSlug\(slug\) \? getCached/u, file);
    assert.match(source, /\.filter\(isContentSlug\)/u, file);
  }
});
