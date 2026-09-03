import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cli = path.resolve('node_modules/supabase/dist/supabase.js');
// See scripts/generate-supabase-types.mjs: `--local` cannot authenticate against
// a linked project's local stack, so address the local database explicitly, and
// how the generator container reaches the host differs between Docker Desktop
// and a plain Linux daemon. Try each candidate rather than pinning one.
const localDatabaseUrls = process.env.SUPABASE_LOCAL_DB_URL
  ? [process.env.SUPABASE_LOCAL_DB_URL]
  : [
      'postgresql://postgres:postgres@host.docker.internal:54322/postgres',
      'postgresql://postgres:postgres@172.17.0.1:54322/postgres',
      'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    ];
let generated;
const attempted = [];
for (const databaseUrl of localDatabaseUrls) {
  attempted.push(new URL(databaseUrl).hostname);
  generated = spawnSync(
    process.execPath,
    [cli, 'gen', 'types', 'typescript', '--db-url', databaseUrl],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (!generated.error && generated.status === 0 && generated.stdout.trim()) break;
}
if (generated.error || generated.status !== 0 || !generated.stdout.trim()) {
  throw new Error(
    `Could not generate local Supabase types. Tried ${attempted.join(', ')}; set ` +
      'SUPABASE_LOCAL_DB_URL to point at the local database directly.',
  );
}

const committed = await readFile('lib/supabase/types.ts', 'utf8');
const requiredSchemaNames = [
  'article_drafts',
  'article_revisions',
  'content_assets',
  'content_asset_usages',
  'course_drafts',
  'course_slug_redirects',
  'save_course_draft',
  'save_course_draft_v2',
  'save_and_publish_course_v2',
  'change_course_slug',
  'publish_course_revision',
  'publish_course_revision_v2',
  'save_and_publish_article_v2',
  'delete_course',
  'delete_article',
  'mark_content_asset_orphan',
  'delete_verified_orphan_asset',
];
const requiredColumns = [
  'current_revision_id',
  'content_version',
  'content_hash',
  'draft_version',
  'storage_key',
  'course_deleted_at',
];
const forbiddenContractNames = [
  'review_course_draft',
  'review_article_draft',
  'next_review_at',
  'reviewed_at',
  'reviewer',
];

function generatedRowContains(source, table, column) {
  const tableStart = source.indexOf(`      ${table}: {\n`);
  if (tableStart < 0) return false;
  const rowStart = source.indexOf('        Row: {\n', tableStart);
  const rowEnd = source.indexOf('        }\n', rowStart);
  return rowStart >= 0 && rowEnd > rowStart && source.slice(rowStart, rowEnd).includes(column);
}

function committedTypeContains(source, typeName, column) {
  const typeStart = source.indexOf(`export type ${typeName} = `);
  if (typeStart < 0) return false;
  const typeEnd = source.indexOf('\n};', typeStart);
  return typeEnd > typeStart && source.slice(typeStart, typeEnd).includes(column);
}

const missingGenerated = [...requiredSchemaNames, ...requiredColumns].filter(
  (name) => !generated.stdout.includes(name),
);
const missingCommitted = [...requiredSchemaNames, ...requiredColumns].filter(
  (name) => !committed.includes(name),
);
if (missingGenerated.length > 0 || missingCommitted.length > 0) {
  console.error(
    JSON.stringify({
      generatedContractMissing: missingGenerated,
      committedContractMissing: missingCommitted,
    }),
  );
  process.exit(1);
}

const staleGenerated = forbiddenContractNames.filter((name) => generated.stdout.includes(name));
const staleCommitted = forbiddenContractNames.filter((name) => committed.includes(name));
if (
  generatedRowContains(generated.stdout, 'course_drafts', 'reviewed_content_hash') ||
  generatedRowContains(generated.stdout, 'article_drafts', 'reviewed_content_hash')
) {
  staleGenerated.push('legacy draft reviewed_content_hash');
}
if (
  committedTypeContains(committed, 'CourseDraftRow', 'reviewed_content_hash') ||
  committedTypeContains(committed, 'ArticleDraftRow', 'reviewed_content_hash')
) {
  staleCommitted.push('legacy draft reviewed_content_hash');
}
if (staleGenerated.length > 0 || staleCommitted.length > 0) {
  console.error(
    JSON.stringify({
      generatedContractStillContains: staleGenerated,
      committedContractStillContains: staleCommitted,
    }),
  );
  process.exit(1);
}

console.log(
  `Supabase type contract passed (${requiredSchemaNames.length} objects, ${requiredColumns.length} columns).`,
);
