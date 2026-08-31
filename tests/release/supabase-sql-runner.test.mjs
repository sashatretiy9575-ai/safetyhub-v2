import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('../../scripts/run-supabase-sql-tests.mjs', import.meta.url),
  'utf8',
);

test('SQL runner reports every contract failure from one disposable database', () => {
  assert.match(source, /const failures = \[\]/u);
  assert.match(source, /failures\.push\(testFile\)/u);
  assert.match(source, /Supabase SQL regression tests failed/u);
  assert.doesNotMatch(source, /if \(result\.status !== 0\) \{\s*process\.exit/u);
});
