import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { prepareReleaseE2eAuth } from './e2e-passwordless-session.mjs';
import { buildReleaseE2eSummary } from './release-e2e-report.mjs';

function sensitiveEnvironmentValues() {
  return [process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY].filter(Boolean);
}

function releaseEnvironment(sessionStates) {
  return {
    ...process.env,
    E2E_REQUIRE_AUTH: '1',
    E2E_ADMIN_STORAGE_STATE: sessionStates.adminStatePath,
    E2E_PARTICIPANT_STORAGE_STATE: sessionStates.participantStatePath,
  };
}

async function main() {
  let sessionStates;
  try {
    sessionStates = await prepareReleaseE2eAuth();
  } catch (error) {
    const code =
      error instanceof Error && /^E2E_AUTH_[A-Z_]+$/u.test(error.message)
        ? error.message
        : 'E2E_AUTH_SESSION_SETUP_FAILED';
    console.error(code);
    process.exitCode = 1;
    return;
  }

  try {
    const result = spawnSync(
      process.execPath,
      ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2), '--reporter=json'],
      {
        cwd: process.cwd(),
        env: releaseEnvironment(sessionStates),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );

    if (result.error) {
      console.error('RELEASE_E2E_RUNNER_START_FAILED');
      process.exitCode = 1;
      return;
    }

    let report;
    try {
      report = JSON.parse(result.stdout);
    } catch {
      console.error('RELEASE_E2E_REPORT_INVALID');
      process.exitCode = result.status ?? 1;
      return;
    }

    const reportDirectory = path.join(process.cwd(), 'test-results');
    mkdirSync(reportDirectory, { recursive: true });
    const sensitiveValues = [...sessionStates.sensitiveValues, ...sensitiveEnvironmentValues()];
    const summary = buildReleaseE2eSummary(report, sensitiveValues);
    writeFileSync(
      path.join(reportDirectory, 'release-e2e-report.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );

    const skipped = summary.tests.filter((entry) => entry.status === 'skipped');
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
      process.exitCode = 1;
      return;
    }
    process.exitCode = failed > 0 ? 1 : (result.status ?? 0);
  } finally {
    await sessionStates.cleanup();
  }
}

await main();
