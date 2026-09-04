// Keeps the approval record in check-linked-release-migrations.mjs in step with
// reality: everything the linked project has already applied belongs to the
// reviewed base, and only the local tail is pending.
//
// Usage: node scripts/refresh-reviewed-pending-migrations.mjs <firstPendingVersion>
// The version is the 14-digit prefix of the earliest migration that production
// has NOT applied yet; check it with `supabase migration list --linked`.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const GATE = path.resolve('scripts', 'check-linked-release-migrations.mjs');
const MIGRATIONS = path.resolve('supabase', 'migrations');
const FIRST_PENDING = process.argv[2];

if (!/^[0-9]{14}$/u.test(FIRST_PENDING ?? '')) {
  throw new Error('Pass the 14-digit version of the first migration production has not applied.');
}

const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.sql')).sort();
const entries = [];
for (const filename of files) {
  const source = await readFile(path.join(MIGRATIONS, filename), 'utf8');
  const sha256 = createHash('sha256')
    .update(Buffer.from(source.replaceAll('\r\n', '\n'), 'utf8'))
    .digest('hex');
  entries.push({ filename, sha256, pending: filename.slice(0, 14) >= FIRST_PENDING });
}

const applied = entries.filter((entry) => !entry.pending);
const pending = entries.filter((entry) => entry.pending);
// The applied-release block is the reviewed tail of the applied history; keep
// the same window size the gate already used.
const appliedReleaseWindow = applied.slice(-27);

const render = (list) =>
  list
    .map(
      ({ filename, sha256 }) =>
        `  Object.freeze({\n    filename: '${filename}',\n    sha256: '${sha256}',\n  }),`,
    )
    .join('\n');

let source = await readFile(GATE, 'utf8');

source = source.replace(
  /export const REVIEWED_BASE_MIGRATION_COUNT = \d+;/u,
  `export const REVIEWED_BASE_MIGRATION_COUNT = ${applied.length};`,
);

for (const [name, list] of [
  ['REVIEWED_APPLIED_RELEASE_MIGRATIONS', appliedReleaseWindow],
  ['REVIEWED_PENDING_MIGRATIONS', pending],
]) {
  const start = source.indexOf(`export const ${name} = Object.freeze([`);
  const end = source.indexOf(']);', start) + 3;
  if (start < 0 || end < 3) throw new Error(`${name} block not found`);
  source = `${source.slice(0, start)}export const ${name} = Object.freeze([\n${render(list)}\n]);${source.slice(end)}`;
}

await writeFile(GATE, source, 'utf8');
console.log(
  JSON.stringify({
    appliedCount: applied.length,
    appliedReleaseCount: appliedReleaseWindow.length,
    pendingCount: pending.length,
    totalCount: entries.length,
  }),
);
