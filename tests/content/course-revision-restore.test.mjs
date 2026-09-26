import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTarget, digest } from '../../scripts/content/restore-course-revision-local.mjs';
const uuid = '11111111-1111-4111-8111-111111111111';
const options = { target: 'local', course: uuid, revision: uuid, expectedCurrent: uuid };
const api = 'http://127.0.0.1:54321';
const database = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
test('restore requires an explicit local target and UUIDs', () => {
  assert.doesNotThrow(() => validateTarget(options, api, database));
  assert.throws(
    () => validateTarget({ ...options, target: undefined }, api, database),
    /LOCAL_TARGET_REQUIRED/,
  );
  assert.throws(
    () => validateTarget({ ...options, expectedCurrent: 'latest' }, api, database),
    /UUID_REQUIRED/,
  );
});
test('restore refuses a production API or database even with local target', () => {
  assert.throws(
    () => validateTarget(options, 'https://example.supabase.co', database),
    /LOCAL_API_REQUIRED/,
  );
  assert.throws(
    () => validateTarget(options, api, 'postgresql://postgres:postgres@db.example:5432/postgres'),
    /LOCAL_DATABASE_REQUIRED/,
  );
});
test('review hash changes with source, current revision, and draft concurrency tokens', () => {
  const plan = { source: 'A', current: 'B', draftVersion: 1 };
  for (const modified of [{ source: 'C' }, { current: 'C' }, { draftVersion: 2 }])
    assert.notEqual(digest(plan), digest({ ...plan, ...modified }));
});
