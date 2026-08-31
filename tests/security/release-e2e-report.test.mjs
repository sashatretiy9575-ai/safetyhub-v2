import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReleaseE2eSummary } from '../../scripts/release-e2e-report.mjs';

test('release E2E evidence excludes environment and redacts temporary credentials', () => {
  const secret = 'temporary-local-password';
  const report = {
    config: { webServer: { env: { E2E_PASSWORD: secret } } },
    suites: [
      {
        specs: [
          {
            file: 'authenticated.spec.ts',
            title: 'logs in',
            tests: [
              {
                status: 'unexpected',
                results: [
                  {
                    status: 'failed',
                    duration: 42,
                    errors: [{ message: `Login failed for ${secret}\nDOM snapshot with sensitive data` }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const summary = buildReleaseE2eSummary(report, [secret]);
  const serialized = JSON.stringify(summary);
  assert.deepEqual(summary.totals, { tests: 1, passed: 0, failed: 1, skipped: 0 });
  assert.deepEqual(summary.runnerErrors, []);
  assert.doesNotMatch(serialized, /temporary-local-password/u);
  assert.doesNotMatch(serialized, /webServer|E2E_PASSWORD|DOM snapshot/u);
  assert.match(serialized, /\[REDACTED\]/u);
});

test('release E2E evidence treats any skipped attempt as a release skip', () => {
  const summary = buildReleaseE2eSummary({
    suites: [
      {
        specs: [
          {
            file: 'release.spec.ts',
            title: 'required scenario',
            tests: [
              { status: 'skipped', results: [{ status: 'skipped', duration: 0, errors: [] }] },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(summary.totals, { tests: 1, passed: 0, failed: 0, skipped: 1 });
});

test('release E2E evidence preserves a redacted runner-level discovery error', () => {
  const secret = 'temporary-local-password';
  const summary = buildReleaseE2eSummary(
    {
      errors: [{ message: `Test discovery failed for ${secret}\nstack with sensitive details` }],
      suites: [],
    },
    [secret],
  );

  assert.deepEqual(summary.totals, { tests: 0, passed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(summary.runnerErrors, ['Test discovery failed for [REDACTED]']);
  assert.doesNotMatch(JSON.stringify(summary), /temporary-local-password|sensitive details/u);
});
