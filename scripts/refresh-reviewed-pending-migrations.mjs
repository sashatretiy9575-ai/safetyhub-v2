// Keeps REVIEWED_PENDING_MIGRATIONS in check-linked-release-migrations.mjs in
// step with the migrations that are on disk but not yet applied to the linked
// project. Run it after adding or editing a pending migration.
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const GATE = path.resolve('scripts', 'check-linked-release-migrations.mjs');
const MIGRATIONS = path.resolve('supabase', 'migrations');
const PENDING_FROM = process.argv[2] ?? '20260903180000';

const files = (await readdir(MIGRATIONS))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .filter((name) => name.slice(0, 14) >= PENDING_FROM);

const entries = [];
for (const filename of files) {
  const source = await readFile(path.join(MIGRATIONS, filename), 'utf8');
  const sha256 = createHash('sha256')
    .update(Buffer.from(source.replaceAll('\r\n', '\n'), 'utf8'))
    .digest('hex');
  entries.push(`  Object.freeze({\n    filename: '${filename}',\n    sha256: '${sha256}',\n  }),`);
}

const source = await readFile(GATE, 'utf8');
const start = source.indexOf('export const REVIEWED_PENDING_MIGRATIONS = Object.freeze([');
const end = source.indexOf(']);', start) + 3;
if (start < 0 || end < 3) throw new Error('REVIEWED_PENDING_MIGRATIONS block not found');
const block = `export const REVIEWED_PENDING_MIGRATIONS = Object.freeze([\n${entries.join('\n')}\n]);`;
await writeFile(GATE, `${source.slice(0, start)}${block}${source.slice(end)}`, 'utf8');
console.log(`reviewed pending migrations: ${entries.length}`);
