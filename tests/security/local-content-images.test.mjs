import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { isSafeArticleImageUrl } from '../../lib/validation/article.ts';

test('article images are repository-owned local assets only', () => {
  for (const value of [
    'https://other-project.supabase.co/storage/v1/object/public/articles/photo.webp',
    'https://safetyhub.example/images/photo.webp',
    '//example.com/photo.webp',
    '/images/photo.svg',
    '/images/photo.webp?version=1',
  ]) {
    assert.equal(isSafeArticleImageUrl(value), false, value);
  }
  assert.equal(isSafeArticleImageUrl('/images/blog/fire-safety.webp'), true);
});

test('Next image optimization exposes no remote image host', async () => {
  const config = await readFile(new URL('../../next.config.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /remotePatterns|domains\s*:/u);
});
