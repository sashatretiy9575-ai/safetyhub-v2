import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const loadingSource = await readFile('app/loading.tsx', 'utf8');
const errorSource = await readFile('app/error.tsx', 'utf8');
const globalErrorSource = await readFile('app/global-error.tsx', 'utf8');
const sharedStateSource = await readFile('components/shared/app-state.tsx', 'utf8');

test('route loading and error states share a reusable app-state surface', () => {
  assert.match(loadingSource, /AppPageLoading/);
  assert.match(errorSource, /AppErrorState/);
  assert.match(globalErrorSource, /AppErrorState/);
  assert.match(sharedStateSource, /export function AppPageLoading/);
  assert.match(sharedStateSource, /export function AppErrorState/);
});

test('route and global error handlers report diagnostic context', () => {
  assert.match(errorSource, /reportAppError/);
  assert.match(globalErrorSource, /reportAppError/);
  assert.match(sharedStateSource, /correlationId/);
});
