import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loadingSource = await readFile('app/loading.tsx', 'utf8');
const errorSource = await readFile('app/error.tsx', 'utf8');
const globalErrorSource = await readFile('app/global-error.tsx', 'utf8');
const sharedStateSource = await readFile('components/shared/app-state.tsx', 'utf8');

test('root boundaries stay provider-free while the global error keeps its reusable state surface', () => {
  // With independent public/private root layouts, these root special files run
  // before a locale provider exists and therefore cannot import/call locale
  // hooks. The explanatory comment itself may safely mention the package.
  assert.doesNotMatch(loadingSource, /AppPageLoading|from ['"]next-intl|useTranslations\(/u);
  assert.doesNotMatch(errorSource, /AppErrorState|useTranslations/u);
  assert.match(globalErrorSource, /AppErrorState/);
  assert.match(sharedStateSource, /export function AppErrorState/);
});

test('route and global error handlers report diagnostic context', () => {
  assert.match(errorSource, /reportAppError/);
  assert.match(globalErrorSource, /reportAppError/);
  assert.match(sharedStateSource, /correlationId/);
});
