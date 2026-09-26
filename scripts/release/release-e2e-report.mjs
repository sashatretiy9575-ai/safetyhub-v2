function safeErrorLine(message, sensitiveValues) {
  let line = typeof message === 'string' ? message.split(/\r?\n/u, 1)[0] : '';
  for (const value of sensitiveValues) {
    if (typeof value === 'string' && value.length > 0) line = line.split(value).join('[REDACTED]');
  }
  return line.slice(0, 500);
}

export function buildReleaseE2eSummary(report, sensitiveValues = []) {
  const tests = [];
  const runnerErrors = (report?.errors ?? [])
    .map((error) => safeErrorLine(error?.message ?? error?.value, sensitiveValues))
    .filter(Boolean);

  function collect(suites) {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          const attempts = (test.results ?? []).map((attempt) => ({
            status: attempt.status,
            durationMs: attempt.duration,
            error: safeErrorLine(attempt.errors?.[0]?.message, sensitiveValues) || undefined,
          }));
          const isSkipped = attempts.some((attempt) => attempt.status === 'skipped');
          tests.push({
            file: spec.file,
            title: spec.title,
            status: isSkipped ? 'skipped' : test.status,
            attempts,
          });
        }
      }
      collect(suite.suites);
    }
  }

  collect(report?.suites);
  const skipped = tests.filter((test) => test.status === 'skipped').length;
  const passed = tests.filter((test) => test.status === 'expected').length;
  const failed = tests.length - passed - skipped;

  return {
    schemaVersion: 1,
    totals: { tests: tests.length, passed, failed, skipped },
    runnerErrors,
    tests,
  };
}
