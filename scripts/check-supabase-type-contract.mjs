import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cli = path.resolve('node_modules/supabase/dist/supabase.js');
const generated = spawnSync(process.execPath, [cli, 'gen', 'types', 'typescript', '--local'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  windowsHide: true,
  timeout: 2 * 60 * 1000,
  maxBuffer: 32 * 1024 * 1024,
});
if (generated.error || generated.status !== 0 || !generated.stdout.trim()) {
  throw new Error('Could not generate local Supabase types.');
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
  'reviewed_content_hash',
  'next_review_at',
  'reviewed_at',
  'reviewer',
];

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
