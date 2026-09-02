import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { articleDocumentSchema } from '../../lib/validation/article.ts';

const read = (file) => readFile(file, 'utf8');
const obsoleteFields = [
  'reviewer',
  'reviewedAt',
  'nextReviewAt',
  'reviewedContentHash',
  'reviewStatus',
];

test('bundled articles use the two-state content metadata contract', async () => {
  const files = (await readdir('content/articles'))
    .filter((file) => file.endsWith('.json'))
    .map((file) => `content/articles/${file}`);

  assert.equal(files.length, 10);
  const slugs = new Set();
  const covers = new Set();

  for (const file of files) {
    const raw = JSON.parse(await read(file));
    for (const field of obsoleteFields) assert.equal(Object.hasOwn(raw, field), false);
    const article = articleDocumentSchema.parse(raw);
    slugs.add(article.slug);
    covers.add(article.coverImage);
    await access(`public${article.coverImage}`);
    assert.equal(article.jurisdiction, 'Республика Казахстан');
    assert.ok(article.sources.length >= 2);
    for (const source of article.sources) {
      assert.match(source.url, /^https:\/\/adilet\.zan\.kz\/rus\/docs\//);
    }
  }

  assert.equal(slugs.size, 10);
  assert.equal(covers.size, 10);
});

test('bundled blog is useful, structured, and written for learners', async () => {
  const files = (await readdir('content/articles')).filter((file) => file.endsWith('.json'));
  const forbiddenAudience = /администратор|administrator/iu;

  for (const file of files) {
    const article = articleDocumentSchema.parse(
      JSON.parse(await readFile(`content/articles/${file}`, 'utf8')),
    );
    const serialized = JSON.stringify(article.blocks);
    const headings = article.blocks.filter((block) => block.type === 'heading');
    const hasListOrTable = article.blocks.some(
      (block) => block.type === 'list' || block.type === 'table',
    );
    const words = serialized.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;

    assert.ok(words >= 300, `${file}: article is too short to be useful`);
    assert.ok(headings.length >= 4, `${file}: needs a scannable heading structure`);
    assert.equal(hasListOrTable, true, `${file}: needs a checklist or comparison table`);
    assert.doesNotMatch(serialized, forbiddenAudience, `${file}: targets an administrator`);
  }
});

test('canonical seed creates drafts and immutable published revisions idempotently', async () => {
  const seed = await read('supabase/seed.sql');
  const files = (await readdir('content/articles')).filter((file) => file.endsWith('.json'));

  for (const file of files) {
    const article = JSON.parse(await readFile(`content/articles/${file}`, 'utf8'));
    assert.match(seed, new RegExp(`"slug"\\s*:\\s*"${article.slug}"`));
    assert.match(seed, new RegExp(article.coverImage.replaceAll('/', '\\/')));
  }
  assert.match(seed, /insert into public\.article_drafts/);
  assert.match(seed, /insert into public\.article_revisions/);
  assert.match(seed, /insert into public\.course_drafts/);
  assert.match(seed, /private\.publish_course_revision_v3_unmetered/);
  assert.match(seed, /on conflict \(slug\) do update/);
  // The legacy review RPCs are retired. Localized drafts deliberately retain
  // their reviewed content hashes so a published four-locale seed can be
  // recreated without a browser-side review step.
  assert.doesNotMatch(seed, /review_course_draft|review_article_draft/);
  const localizedSeedStart = seed.indexOf('-- Published RU/KK/EN/ZH snapshot.');
  const localizedSeedEnd = seed.indexOf('$localized_seed$;', localizedSeedStart);
  assert.ok(localizedSeedStart >= 0 && localizedSeedEnd > localizedSeedStart);
  const localizedSeed = seed.slice(localizedSeedStart, localizedSeedEnd);
  assert.match(localizedSeed, /reviewed_content_hash/);
  assert.doesNotMatch(
    localizedSeed,
    /correct_option|correctOptionId|answer_key|answerKey|auth\.users|auth\.sessions|auth\.identities|public\.profiles|public\.attempts|public\.certificates|public\.legal_acceptances|admin_audit_log/iu,
  );
  assert.doesNotMatch(seed, /create temporary table|create temp table/iu);
});

test('article editor keeps sources optional and publishes directly', async () => {
  const [editor, action, content, page, contract] = await Promise.all([
    read('components/admin/admin-editor.tsx'),
    read('lib/actions/articles.ts'),
    read('lib/content/articles.ts'),
    read('app/(public)/blog/[slug]/page.tsx'),
    read('supabase/migrations/20260820010000_content_lifecycle_contract.sql'),
  ]);

  assert.match(editor, /Данные материала и источники/);
  assert.match(editor, /необязательны и не блокируют публикацию/iu);
  assert.match(editor, /Есть черновик/);
  assert.doesNotMatch(editor, /Ревью|reviewReady|reviewedContentHash/);
  assert.match(action, /save_article_draft_v2/);
  assert.match(action, /set_article_status_v2/);
  assert.match(action, /delete_article/);
  assert.doesNotMatch(content, /reviewer|reviewed_at|next_review_at/);
  assert.match(page, /label=\{t\('sources'/u);
  assert.doesNotMatch(page, /[\u0400-\u04ff]/u);
  assert.match(
    contract,
    /create type public\.article_status_two_state as enum \('draft', 'published'\)/,
  );
  assert.match(contract, /drop function if exists public\.review_article_draft/);
  assert.match(contract, /drop column if exists reviewed_content_hash/);
  assert.doesNotMatch(action, /review_article_draft/);
});
