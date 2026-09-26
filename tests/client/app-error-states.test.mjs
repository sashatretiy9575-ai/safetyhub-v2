import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loadingSource = await readFile('app/(account)/loading.tsx', 'utf8');
const errorSource = await readFile('app/error.tsx', 'utf8');
const globalErrorSource = await readFile('app/global-error.tsx', 'utf8');
const notFoundSource = await readFile('app/not-found.tsx', 'utf8');
const accountNotFoundSource = await readFile('app/(account)/not-found.tsx', 'utf8');
const noticeSource = await readFile('components/shared/not-found-notice.tsx', 'utf8');

test('root boundaries stay provider-free and dependency-light', () => {
  // With independent public/private root layouts, these root special files run
  // before a locale provider exists and therefore cannot import/call locale
  // hooks. Their chunks load on every route, so they must not pull in Button,
  // Container or next/link (each brought its own copy of cva, Radix Slot and
  // tailwind-merge into every page).
  assert.doesNotMatch(loadingSource, /AppPageLoading|from ['"]next-intl|useTranslations\(/u);
  for (const source of [errorSource, globalErrorSource, noticeSource]) {
    assert.doesNotMatch(source, /useTranslations|from '@\/components\/ui\/(button|container)'|from 'next\/link'/u);
  }
  // global-error replaces every layout and gets no stylesheet: it styles itself.
  assert.match(globalErrorSource, /<html lang=\{htmlLanguage\(locale\)\}/u);
  assert.match(globalErrorSource, /style=\{styles\.body\}/u);
  assert.match(globalErrorSource, /<title>/u);
});

test('the root 404 owns a styled document and the private group has its own', () => {
  assert.match(notFoundSource, /import '\.\/globals\.css';/u);
  assert.match(notFoundSource, /<html lang="ru"/u);
  assert.match(notFoundSource, /title: '404 — SafetyHub'/u);
  assert.match(notFoundSource, /robots: \{ index: false, follow: false \}/u);
  assert.match(accountNotFoundSource, /<NotFoundNotice \/>/u);
  assert.doesNotMatch(accountNotFoundSource, /<html/u);
});

test('route and global error handlers report diagnostic context once per mount', () => {
  assert.match(errorSource, /useState\(\(\) => reportAppError\(error/u);
  assert.match(globalErrorSource, /useState\(\(\) =>\s*reportAppError\(error/u);
  assert.match(errorSource, /diagnostic\.correlationId/u);
  assert.match(globalErrorSource, /diagnostic\.correlationId/u);
});
