// Compares two files written by e2e/admin-perf.spec.ts and prints Markdown.
//
//   node scripts/dev/summarize-admin-perf.mjs <before.json> <after.json> [--all]
//
// Per scenario: one table of timings and CPU (p50 and p90, before → after, delta %) and one
// table of requests (count and bytes per class). Rows that are empty or zero on both sides are
// left out unless --all is given. Pure Node, no dependencies.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SKIPPED_KEYS = new Set(['raw', 'notes', 'error', 'run', 't0Source', 'skipped']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readReport(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.scenarios !== 'object') {
    fail(`${file} is not an admin-perf report (no "scenarios").`);
  }
  return parsed;
}

function flatten(value, prefix, out) {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) out.set(prefix, value);
  } else if (typeof value === 'boolean') {
    out.set(prefix, value ? 1 : 0);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SKIPPED_KEYS.has(key)) continue;
      flatten(item, prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

function percentile(sorted, fraction) {
  const rank = (sorted.length - 1) * fraction;
  const low = sorted[Math.floor(rank)] ?? 0;
  const high = sorted[Math.ceil(rank)] ?? low;
  return low + (high - low) * (rank - Math.floor(rank));
}

/** metric path -> { n, p50, p90 }, recomputed from the raw runs so both files are read alike. */
function statsOf(scenario) {
  const stats = new Map();
  const runs = Array.isArray(scenario?.runs) ? scenario.runs : null;
  if (!runs) {
    for (const [key, value] of Object.entries(scenario?.summary ?? {})) {
      stats.set(key, { n: value.n, p50: value.p50, p90: value.p90 });
    }
    return stats;
  }
  const samples = new Map();
  for (const run of runs) {
    if (typeof run?.error === 'string') continue;
    const flat = new Map();
    flatten(run, '', flat);
    for (const [key, value] of flat) samples.set(key, [...(samples.get(key) ?? []), value]);
  }
  for (const [key, values] of samples) {
    const sorted = [...values].sort((left, right) => left - right);
    stats.set(key, {
      n: sorted.length,
      p50: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
    });
  }
  return stats;
}

const REQUEST_PATH = /(?:^|\.)requests\.([A-Za-z0-9]+)(?:\.(count|bytes))?$/;

function formatNumber(value, unit) {
  if (value === undefined || value === null) return 'n/a';
  if (unit === 'bytes') {
    return value >= 10_240 ? `${(value / 1024).toFixed(1)} KiB` : `${Math.round(value)} B`;
  }
  if (unit === 'count') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function formatDelta(before, after) {
  if (before === undefined || after === undefined) return 'n/a';
  if (before === 0) return after === 0 ? '0%' : 'new';
  const delta = ((after - before) / Math.abs(before)) * 100;
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

const arrow = (before, after, unit) =>
  `${formatNumber(before, unit)} → ${formatNumber(after, unit)}`;

function unitOf(metric) {
  if (/Ms$|Ms\./.test(metric)) return 'ms';
  if (/bytes$/i.test(metric)) return 'bytes';
  return 'count';
}

function describe(report, file) {
  const profile = report.profile?.name ?? '?';
  const dirty = report.dirty ? ' (uncommitted changes)' : '';
  return `\`${path.basename(file)}\` — label \`${report.label}\`, commit \`${report.commit ?? '?'}\`${dirty}, profile \`${profile}\`, runs ${report.runs}`;
}

const [beforeFile, afterFile, ...flags] = process.argv.slice(2);
if (!beforeFile || !afterFile) {
  fail('Usage: node scripts/dev/summarize-admin-perf.mjs <before.json> <after.json> [--all]');
}
const showAll = flags.includes('--all');
const before = readReport(beforeFile);
const after = readReport(afterFile);

const lines = [];
lines.push('# Admin performance: before → after', '');
lines.push(`- before: ${describe(before, beforeFile)}`);
lines.push(`- after: ${describe(after, afterFile)}`);
if (before.profile?.name !== after.profile?.name) {
  lines.push('', '> **The two files were measured under different profiles; the deltas mean little.**');
}
if (before.runs !== after.runs) {
  lines.push('', `> Runs differ: ${before.runs} before, ${after.runs} after.`);
}
lines.push(
  '',
  'Times are milliseconds from the user action. `recreated`, `hasPhoto`, `unavailableSeen` and other yes/no values are shown as the share of runs (0–1). `n` is the number of runs that produced the value, before/after.',
);

const scenarioNames = [
  ...new Set([...Object.keys(before.scenarios), ...Object.keys(after.scenarios)]),
].sort();

for (const name of scenarioNames) {
  const left = before.scenarios[name];
  const right = after.scenarios[name];
  const leftStats = statsOf(left);
  const rightStats = statsOf(right);
  const metrics = [...new Set([...leftStats.keys(), ...rightStats.keys()])].sort((a, b) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  lines.push('', `## ${name}`, '');
  lines.push(
    `Failed runs: ${left?.errors ?? 'n/a'} before, ${right?.errors ?? 'n/a'} after (of ${left?.runs?.length ?? 0} / ${right?.runs?.length ?? 0}).`,
  );

  const timingRows = [];
  const requestRows = new Map();
  for (const metric of metrics) {
    const b = leftStats.get(metric);
    const a = rightStats.get(metric);
    const request = REQUEST_PATH.exec(metric);
    if (request) {
      const scope = metric.slice(0, request.index);
      const key = `${scope ? scope + ' · ' : ''}${request[1]}`;
      const row = requestRows.get(key) ?? {};
      row[request[2] ?? 'count'] = { b, a };
      requestRows.set(key, row);
      continue;
    }
    const empty = !(b?.p50 || b?.p90 || a?.p50 || a?.p90);
    if (empty && !showAll) continue;
    const unit = unitOf(metric);
    timingRows.push(
      `| ${metric} | ${arrow(b?.p50, a?.p50, unit)} | ${formatDelta(b?.p50, a?.p50)} | ${arrow(b?.p90, a?.p90, unit)} | ${formatDelta(b?.p90, a?.p90)} | ${b?.n ?? 0}/${a?.n ?? 0} |`,
    );
  }

  if (timingRows.length) {
    lines.push(
      '',
      '| metric | p50 before → after | Δ p50 | p90 before → after | Δ p90 | n |',
      '| --- | --- | --- | --- | --- | --- |',
      ...timingRows,
    );
  } else {
    lines.push('', '_No timing values on either side._');
  }

  const requestLines = [];
  for (const [key, row] of requestRows) {
    const count = row.count ?? {};
    const bytes = row.bytes ?? {};
    const empty = !(count.b?.p50 || count.a?.p50 || bytes.b?.p50 || bytes.a?.p50);
    if (empty && !showAll) continue;
    requestLines.push(
      `| ${key} | ${arrow(count.b?.p50, count.a?.p50, 'count')} | ${formatDelta(count.b?.p50, count.a?.p50)} | ${arrow(bytes.b?.p50, bytes.a?.p50, 'bytes')} | ${formatDelta(bytes.b?.p50, bytes.a?.p50)} |`,
    );
  }
  if (requestLines.length) {
    lines.push(
      '',
      '| requests (p50 per run) | count before → after | Δ count | bytes before → after | Δ bytes |',
      '| --- | --- | --- | --- | --- |',
      ...requestLines,
    );
  }
}

console.log(lines.join('\n'));
