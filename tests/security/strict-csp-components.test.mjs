import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const progressSource = await readFile(
  new URL('../../components/ui/progress.tsx', import.meta.url),
  'utf8',
);

test('quiz progress works under the protected-route CSP without inline styles', () => {
  assert.match(progressSource, /<progress\b/);
  assert.doesNotMatch(progressSource, /style\s*=\s*\{\{/);
  assert.doesNotMatch(progressSource, /@radix-ui\/react-progress/);
  assert.match(progressSource, /value=\{safeValue\}/);
  assert.match(progressSource, /max=\{safeMax\}/);
});
