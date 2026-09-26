import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('the release run leaves the opt-in responsive sweep out instead of reporting it as skipped', async () => {
  const [config, runner, sweep] = await Promise.all([
    read('playwright.config.ts'),
    read('scripts/release/run-e2e-release.mjs'),
    read('e2e/responsive-sweep.spec.ts'),
  ]);
  assert.ok(
    config.includes(
      "testIgnore: process.env.E2E_SWEEP === '1' ? [] : ['**/responsive-sweep.spec.ts']",
    ),
  );
  assert.ok(sweep.includes("process.env.E2E_SWEEP === '1'"));
  // The gate itself stays strict: any other skipped test still fails the release.
  assert.ok(runner.includes('skipped.length > 0'));
});

test('the capacity profile grants its learners the courses before reading presentations', async () => {
  const harness = await read('scripts/release/load-test-supabase.mjs');
  const grant = harness.indexOf("'course_access_grants'");
  assert.ok(grant > 0);
  assert.ok(grant < harness.indexOf("'get_approved_course_presentation_locale'"));
  assert.ok(grant < harness.indexOf("'start_test_attempt_locale'"));
});
