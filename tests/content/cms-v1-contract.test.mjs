import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('course publication writes an immutable revision without a review operation', async () => {
  const [additive, contract, topics, server] = await Promise.all([
    read('supabase/migrations/20260820000000_content_lifecycle_additive.sql'),
    read('supabase/migrations/20260820010000_content_lifecycle_contract.sql'),
    read('lib/content/topics.ts'),
    read('features/admin/server.ts'),
  ]);

  assert.match(additive, /private\.publish_course_revision_v2_unmetered/);
  assert.match(additive, /function public\.save_and_publish_course_v2/);
  assert.match(
    additive,
    /v_saved := private\.save_course_draft_v2_unmetered[\s\S]+private\.publish_course_revision_v2_unmetered/,
  );
  assert.match(
    additive,
    /function public\.save_and_publish_course_v2[\s\S]+perform private\.enforce_actor_quota\('admin\.test\.mutate'\);[\s\S]+begin[\s\S]+private\.save_course_draft_v2_unmetered/,
  );
  assert.match(additive, /from public\.course_drafts where test_id = p_test_id for update/);
  assert.match(additive, /v_draft\.content_hash is distinct from p_expected_content_hash/);
  assert.match(additive, /insert into public\.test_revisions/);
  assert.match(additive, /current_revision_id = v_revision_id/);
  assert.match(contract, /create or replace function public\.change_course_slug/);
  assert.match(contract, /course_slug_redirects/);
  assert.match(topics, /\.from\('test_revisions'\)/);
  assert.match(server, /save_and_publish_course_v3/);
  assert.doesNotMatch(server, /authenticatedRpc\('change_course_slug'/);
  assert.match(additive, /delete from public\.course_slug_redirects/);
  assert.doesNotMatch(
    additive,
    /function public\.save_and_publish_course_v2[\s\S]+v_changed := public\.change_course_slug/,
  );
  assert.doesNotMatch(server, /review_course_draft|reviewedContentHash/);
});

test('articles publish the current draft directly with optimistic concurrency', async () => {
  const [additive, action, editor] = await Promise.all([
    read('supabase/migrations/20260820000000_content_lifecycle_additive.sql'),
    read('lib/actions/articles.ts'),
    read('components/admin/admin-editor.tsx'),
  ]);

  assert.match(additive, /private\.set_article_status_v2_unmetered/);
  assert.match(additive, /function public\.save_and_publish_article_v2/);
  assert.match(
    additive,
    /v_saved := private\.save_article_draft_v2_unmetered[\s\S]+private\.set_article_status_v2_unmetered/,
  );
  assert.match(
    additive,
    /function public\.save_and_publish_article_v2[\s\S]+perform private\.enforce_actor_quota\('content\.article\.mutate'\);[\s\S]+begin[\s\S]+private\.save_article_draft_v2_unmetered/,
  );
  assert.match(additive, /ARTICLE_DRAFT_CONFLICT/);
  assert.match(additive, /p_expected_content_hash/);
  assert.match(additive, /insert into public\.article_revisions/);
  assert.match(action, /set_article_status_v2/);
  assert.match(action, /save_and_publish_article_v2/);
  assert.match(action, /p_expected_content_hash: expectedContentHash \?\? null/);
  assert.doesNotMatch(action, /review_article_draft/);
  assert.match(editor, /draftVersion/);
  assert.match(editor, /publishArticleAction/);
});

test('destructive content deletion is transactional and preserves certificate snapshots', async () => {
  const [migration, dialog, courseServer, articleActions, attestationTypes] = await Promise.all([
    read('supabase/migrations/20260820000000_content_lifecycle_additive.sql'),
    read('components/admin/destructive-dialog.tsx'),
    read('features/admin/server.ts'),
    read('lib/actions/articles.ts'),
    read('features/admin/types.ts'),
  ]);

  assert.match(migration, /create or replace function public\.delete_course/);
  assert.match(migration, /create or replace function public\.delete_article/);
  assert.match(migration, /p_expected_version/);
  assert.match(migration, /for update/);
  assert.match(migration, /course_deleted_at = v_deleted_at/);
  assert.match(
    migration,
    /set revision_id = null,[\s\S]+attestation_id = null,[\s\S]+attempt_id = null/,
  );
  assert.match(migration, /delete from public\.tests where id = p_test_id/);
  assert.match(migration, /delete from public\.articles where id = p_article_id/);
  assert.match(migration, /status = 'orphan_candidate'/);
  assert.match(
    migration,
    /function public\.delete_course[\s\S]+perform private\.enforce_actor_quota\('admin\.test\.mutate'\);[\s\S]+begin[\s\S]+select \* into v_test[\s\S]+exception when others/,
  );
  assert.match(
    migration,
    /function public\.delete_article[\s\S]+perform private\.enforce_actor_quota\('content\.article\.mutate'\);[\s\S]+begin[\s\S]+select \* into v_article[\s\S]+exception when others/,
  );
  assert.match(dialog, /Да, удалить без возможности восстановления/);
  assert.match(dialog, /disabled=\{!confirmed \|\| busy\}/);
  assert.match(courseServer, /authenticatedRpc\('delete_course'/);
  assert.match(articleActions, /rpc\('delete_article'/);
  assert.match(attestationTypes, /'deleted-course-certificate'/);
  assert.match(attestationTypes, /courseDeleted: boolean/);
});

test('optional content metadata participates in draft identity', async () => {
  const [additive, contract, seedGenerator] = await Promise.all([
    read('supabase/migrations/20260820000000_content_lifecycle_additive.sql'),
    read('supabase/migrations/20260820010000_content_lifecycle_contract.sql'),
    read('scripts/generate-content-seed.mjs'),
  ]);

  for (const source of [additive, contract]) {
    assert.match(source, /course_content_hash_v2/);
    assert.match(source, /article_content_hash_v2/);
  }
  assert.match(seedGenerator, /course_content_hash_v3/);
  assert.match(seedGenerator, /article_content_hash_v2/);
  assert.match(seedGenerator, /dbContentHash/);
  assert.match(additive, /'jurisdiction', coalesce\(p_jurisdiction, ''\)/);
  assert.match(additive, /'effectiveDate', coalesce\(p_effective_date::text, ''\)/);
  assert.match(additive, /'sources', coalesce\(p_sources, '\[\]'::jsonb\)/);
  assert.match(
    additive,
    /v_hash := private\.article_content_hash_v2\([\s\S]+v_jurisdiction, v_effective_date, v_sources/,
  );
  assert.match(
    additive,
    /v_hash := private\.course_content_hash_v2\([\s\S]+p_content_metadata ->> 'jurisdiction'[\s\S]+p_content_metadata ->> 'effectiveDate'[\s\S]+v_sources/,
  );
});

test('deleted-course certificates remain searchable historical ledger rows only', async () => {
  const [historyMigration, mapper, panels] = await Promise.all([
    read('supabase/migrations/20260820001000_deleted_certificate_admin_rows.sql'),
    read('features/admin/attestations.ts'),
    read('components/admin/attestations-manager-panels.tsx'),
  ]);

  assert.match(historyMigration, /where certificate\.course_deleted_at is not null/);
  assert.match(historyMigration, /private\.normalized_lookup_key\(row\.course_title\)/);
  assert.match(historyMigration, /private\.normalized_lookup_key\(row\.certificate_number\)/);
  assert.match(historyMigration, /'recordId', page\.attestation_id/);
  assert.match(historyMigration, /'kind', case when page\.test_id is null/);
  assert.match(
    historyMigration,
    /'attestationId', case when page\.test_id is null then null else page\.attestation_id end/,
  );
  assert.match(historyMigration, /'revisionId', page\.revision_id/);
  assert.match(historyMigration, /'bestAttemptId', page\.best_attempt_id/);
  assert.match(historyMigration, /'courseDeleted', page\.test_id is null/);
  assert.match(historyMigration, /'attestationIds',[\s\S]+filter \(where test_id is not null\)/);
  assert.match(
    historyMigration,
    /'certificateIds',[\s\S]+filter \(where certificate_id is not null and certificate_state = 'issued'\)/,
  );
  assert.match(mapper, /kind: courseDeleted \? 'deleted-course-certificate' : 'attestation'/);
  assert.match(panels, /Курс удалён/);
});

test('CMS media deletion remains usage-checked and storage-first', async () => {
  const [migration, server, route, picker] = await Promise.all([
    read('supabase/migrations/20260819000000_content_publication_v1.sql'),
    read('features/admin/server.ts'),
    read('app/api/admin/content-assets/[assetId]/route.ts'),
    read('components/admin/media-asset-input.tsx'),
  ]);

  assert.match(migration, /create or replace function public\.mark_content_asset_orphan/);
  assert.match(migration, /create or replace function public\.delete_verified_orphan_asset/);
  assert.match(migration, /from public\.content_asset_usages usage/);
  assert.match(migration, /delete_pending/);
  const storageRemoval = server.indexOf("storage.from('content-media').remove");
  const metadataDeletion = server
    .slice(storageRemoval)
    .search(/\.from\('content_assets'\)\r?\n\s+\.delete\(\)/);
  assert.ok(storageRemoval >= 0 && metadataDeletion >= 0);
  assert.match(route, /invalidOriginResponse\(request\)/);
  assert.match(route, /consumeAdminMutationQuota/);
  assert.match(picker, /usageCount === 0/);
  assert.match(picker, /prepareContentImage/);
});

test('shared editors reuse action, SEO, media and content primitives', async () => {
  const [articleEditor, courseEditor, actionBar, seoEditor, blockEditor, iconPicker] =
    await Promise.all([
      read('components/admin/admin-editor.tsx'),
      read('components/admin/test-editor.tsx'),
      read('components/admin/editor-action-bar.tsx'),
      read('components/admin/content-seo-editor.tsx'),
      read('components/admin/content-block-editor.tsx'),
      read('components/admin/icon-picker.tsx'),
    ]);

  assert.match(articleEditor, /<EditorActionBar/);
  assert.match(courseEditor, /<EditorActionBar/);
  assert.match(actionBar, /max-h-16/);
  assert.match(articleEditor, /<ContentSeoEditor/);
  assert.match(courseEditor, /<ContentSeoEditor/);
  assert.match(courseEditor, /<CoursePresentationInput/);
  assert.doesNotMatch(courseEditor, /<CourseContentEditor|<ContentBlockEditor/);
  assert.match(seoEditor, /<MediaAssetInput/);
  assert.match(blockEditor, /BLOCK_LABELS/);
  assert.match(iconPicker, /onKeyDown=\{navigate\}/);
  assert.match(iconPicker, /ArrowRight/);
  assert.doesNotMatch(blockEditor, /dangerouslySetInnerHTML/);
});
