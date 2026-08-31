import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { buildReleaseE2eSummary } from './release-e2e-report.mjs';

const required = ['E2E_ADMIN_EMAIL', 'E2E_PARTICIPANT_EMAIL'];
const missing = required.filter((name) => !process.env[name]);
if (!process.env.E2E_PASSWORD && !process.env.SAFETYHUB_SEED_PASSWORD) {
  missing.push('E2E_PASSWORD or SAFETYHUB_SEED_PASSWORD');
}
if (missing.length) {
  console.error(`Authenticated release E2E credentials are missing: ${missing.join(', ')}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['node_modules/@playwright/test/cli.js', 'test', '--reporter=json'],
  {
    cwd: process.cwd(),
    env: { ...process.env, E2E_REQUIRE_AUTH: '1' },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
if (result.stderr) process.stderr.write(result.stderr);

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  console.error('Playwright did not produce a valid JSON release report.');
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}

const reportDirectory = path.join(process.cwd(), 'test-results');
mkdirSync(reportDirectory, { recursive: true });
const sensitiveValues = [
  process.env.E2E_PASSWORD,
  process.env.SAFETYHUB_SEED_PASSWORD,
  process.env.SUPABASE_SECRET_KEY,
].filter(Boolean);
const summary = buildReleaseE2eSummary(report, sensitiveValues);
writeFileSync(
  path.join(reportDirectory, 'release-e2e-report.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
  'utf8',
);

const skipped = summary.tests.filter((test) => test.status === 'skipped');
const { passed, failed } = summary.totals;

console.log(`Release E2E: ${passed} passed, ${failed} failed, ${skipped.length} skipped.`);
for (const message of summary.runnerErrors) {
  console.error(`RELEASE_E2E_RUNNER_ERROR: ${message}`);
}
for (const entry of skipped) {
  console.error(`RELEASE_E2E_SKIPPED: ${entry.file}: ${entry.title}`);
}

if (summary.totals.tests === 0) {
  console.error('RELEASE_E2E_EMPTY: Playwright did not execute any release tests.');
}
if (summary.runnerErrors.length > 0 || skipped.length > 0 || summary.totals.tests === 0) {
  process.exit(1);
}
process.exit(result.status ?? (failed > 0 ? 1 : 0));
