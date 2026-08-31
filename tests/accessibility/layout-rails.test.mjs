import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('header, page headers, catalogs, and marketing share the 1280px rail', async () => {
  const [container, header, pageHeader, blog, topics, sectionShell] = await Promise.all([
    read('components/ui/container.tsx'),
    read('components/layout/header.tsx'),
    read('components/ui/page-header.tsx'),
    read('app/(public)/blog/page.tsx'),
    read('app/(public)/topics/page.tsx'),
    read('components/marketing/_shared/section-shell.tsx'),
  ]);

  assert.match(container, /wide: 'max-w-\[1280px\]'/);
  assert.match(container, /var\(--safe-area-left\)/);
  assert.match(header, /max-w-\[1280px\]/);
  assert.match(pageHeader, /<Container size="wide"/);
  assert.match(blog, /<Container size="wide"/);
  assert.match(topics, /<Container size="wide"/);
  assert.match(sectionShell, /max-w-\[1280px\]/);
});

test('catalogs use compact headers and reveal content in the first mobile viewport', async () => {
  const [pageHeader, blog, topics] = await Promise.all([
    read('components/ui/page-header.tsx'),
    read('app/(public)/blog/page.tsx'),
    read('app/(public)/topics/page.tsx'),
  ]);

  assert.match(pageHeader, /variant\?: 'default' \| 'compact' \| 'contact'/);
  assert.match(pageHeader, /'py-7 sm:py-9 md:py-12'/);
  assert.match(blog, /variant="compact"/);
  assert.match(blog, /<section className="py-9 sm:py-12 lg:py-16">/);
  assert.match(topics, /variant="compact"/);
});

test('article editor cannot emit the old missing placeholder asset', async () => {
  const [editor, validation] = await Promise.all([
    read('components/admin/admin-editor.tsx'),
    read('lib/validation/article.ts'),
  ]);

  assert.doesNotMatch(editor, /\/images\/blog\/placeholder\.jpg/);
  assert.match(editor, /initialData\?\.coverImage \?\? ''/);
  assert.match(validation, /coverImage: articleCoverImageSchema/);
  assert.match(validation, /z\.union\(\[z\.literal\(''\), articleImageUrlSchema\]\)/);
});
