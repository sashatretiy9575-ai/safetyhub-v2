import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const snapshotRoot = path.join(root, 'content', 'snapshots', 'courses');
const seedPath = path.join(root, 'supabase', 'seed.sql');
const seed = await fs.readFile(seedPath, 'utf8');
const match = seed.match(/\$courses\$(\[[\s\S]*?\])\$courses\$::jsonb/u);
if (!match) throw new Error('supabase/seed.sql does not contain a $courses$ JSON bundle');

const embedded = JSON.parse(match[1]);
const catalog = JSON.parse(await fs.readFile(path.join(snapshotRoot, 'catalog.json'), 'utf8'));
const expected = [];
for (const item of catalog.courses) {
  expected.push(
    JSON.parse(await fs.readFile(path.join(snapshotRoot, item.slug, 'course.json'), 'utf8')),
  );
}

assert.deepEqual(embedded, expected, 'supabase/seed.sql differs from content/snapshots/courses');
console.log(
  JSON.stringify(
    {
      valid: true,
      courseCount: embedded.length,
      catalogChecksum: catalog.catalogChecksum,
      dbContentHashes: embedded.map(({ slug, dbContentHash }) => ({ slug, dbContentHash })),
    },
    null,
    2,
  ),
);
