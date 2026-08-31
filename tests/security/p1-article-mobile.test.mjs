import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTICLE_LIMITS,
  articleDraftInputSchema,
  isSafeArticleButtonUrl,
  isSafeArticleImageUrl,
} from '../../lib/validation/article.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

const validArticle = {
  slug: 'safe-article',
  title: 'Безопасная статья',
  description: 'Краткое описание',
  coverImage: '/images/generated/article-cover.webp',
  blocks: [{ type: 'paragraph', content: 'Проверенный текст.' }],
};

test('article payload accepts only the supported discriminated blocks', () => {
  assert.equal(articleDraftInputSchema.safeParse(validArticle).success, true);

  for (const block of [
    { type: 'image', src: '', alt: 'Обложка' },
    { type: 'heading', content: 'Неверный уровень', level: 1 },
    { type: 'button', text: 'Опасная ссылка', url: 'javascript:alert(1)', style: 'primary' },
    { type: 'video', src: '/images/generated/video.webp' },
    { type: 'divider', unexpected: true },
  ]) {
    assert.equal(
      articleDraftInputSchema.safeParse({ ...validArticle, blocks: [block] }).success,
      false,
      `block must be rejected: ${JSON.stringify(block)}`,
    );
  }
});

test('article URL allowlists reject traversal and unsupported hosts', () => {
  assert.equal(isSafeArticleImageUrl('/images/generated/photo.webp'), true);
  assert.equal(
    isSafeArticleImageUrl(
      'https://project-ref.supabase.co/storage/v1/object/public/articles/photo.avif',
    ),
    false,
  );
  assert.equal(isSafeArticleImageUrl('/images/../secrets.png'), false);
  assert.equal(isSafeArticleImageUrl('https://example.com/photo.webp'), false);
  assert.equal(isSafeArticleButtonUrl('/topics/fire-safety?from=article#test'), true);
  assert.equal(isSafeArticleButtonUrl('/contacts?channel=whatsapp'), true);
  assert.equal(isSafeArticleButtonUrl('https://wa.me/77000000000'), false);
  assert.equal(isSafeArticleButtonUrl('//evil.example/path'), false);
  assert.equal(isSafeArticleButtonUrl('javascript:alert(1)'), false);
});

test('article count and serialized size limits fail before persistence', () => {
  const tooManyBlocks = Array.from({ length: ARTICLE_LIMITS.maxBlocks + 1 }, () => ({
    type: 'divider',
  }));
  assert.equal(
    articleDraftInputSchema.safeParse({ ...validArticle, blocks: tooManyBlocks }).success,
    false,
  );

  const longImage = `/images/${'a'.repeat(1_780)}.webp`;
  const oversizedBlocks = Array.from({ length: 9 }, () => ({
    type: 'slider',
    images: Array.from({ length: 10 }, () => longImage),
  }));
  const oversized = articleDraftInputSchema.safeParse({
    ...validArticle,
    blocks: oversizedBlocks,
  });
  assert.equal(oversized.success, false);
  if (!oversized.success) {
    assert.ok(
      oversized.error.issues.some((issue) => issue.message === 'ARTICLE_PAYLOAD_TOO_LARGE'),
    );
  }
});

test('server actions validate before authentication or database access', async () => {
  const source = await read('lib/actions/articles.ts');
  const saveStart = source.indexOf('export async function saveArticleAction');
  const statusStart = source.indexOf('export async function setArticleStatusAction');
  const saveBody = source.slice(saveStart, statusStart);
  const statusBody = source.slice(statusStart);

  assert.ok(
    saveBody.indexOf('articleDraftInputSchema.parse') < saveBody.indexOf('requireCapability'),
  );
  assert.ok(
    saveBody.indexOf('articleDraftInputSchema.parse') <
      saveBody.indexOf("rpc('save_article_draft_v2'"),
  );
  assert.ok(
    statusBody.indexOf('articleStatusInputSchema.parse') < statusBody.indexOf('requireCapability'),
  );
  assert.match(statusBody, /rpc\('set_article_status_v2'/);
});

test('database lifecycle preserves first publication and records redirects atomically', async () => {
  const migration = await read('supabase/migrations/20260820010000_content_lifecycle_contract.sql');
  assert.match(
    migration,
    /create type public\.article_status_two_state as enum \('draft', 'published'\)/,
  );
  assert.match(migration, /jsonb_typeof\(p_blocks\) is distinct from 'array'/);
  assert.match(migration, /jsonb_array_length\(p_blocks\) > 100/);
  assert.match(migration, /pg_column_size\(p_blocks\) > 131072/);
  assert.match(migration, /public\.article_slug_redirects/);
  assert.match(migration, /where id = p_article_id\s+for update/s);
  assert.match(migration, /insert into public\.article_slug_redirects/);
  assert.match(migration, /published_at = coalesce\(published_at, statement_timestamp\(\)\)/);
  assert.match(migration, /private\.require_capability\('content\.manage'\)/);
  assert.match(migration, /p_expected_content_hash/);
  assert.doesNotMatch(migration, /enum \('draft', 'published', 'archived'\)/);
});

test('narrow layouts and course actions avoid clipping and scroll jumps', async () => {
  const [editor, editorShell, actionBar, blockEditor, turnstile, courseActions] = await Promise.all(
    [
      read('components/admin/admin-editor.tsx'),
      read('components/admin/editor-shell.tsx'),
      read('components/admin/editor-action-bar.tsx'),
      read('components/admin/content-block-editor.tsx'),
      read('features/auth/turnstile.tsx'),
      read('components/topics/course-material-actions.tsx'),
    ],
  );

  assert.match(actionBar, /top-\[calc\(3\.5rem\+var\(--safe-area-top\)\)\]/);
  assert.match(actionBar, /md:top-4/);
  assert.match(actionBar, /max-h-16/);
  assert.match(blockEditor, /grid gap-2 sm:grid-cols-2/);
  assert.match(blockEditor, /size="icon"/);
  assert.match(editor, /min-w-0/);
  assert.match(editor, /<EditorShell>/);
  assert.match(editorShell, /max-w-full/);

  assert.match(turnstile, /new ResizeObserver/);
  assert.match(turnstile, /width >= 300 \? 'flexible' : 'compact'/);
  assert.match(turnstile, /execution: 'execute'/);
  assert.match(turnstile, /if \(!siteKey \|\| !activated\) return null/);
  assert.match(turnstile, /window\.turnstile\.remove/);
  assert.doesNotMatch(turnstile, /pointerdown|focusin|keydown/);
  assert.doesNotMatch(turnstile, /Проверка пройдена|CheckCircle|ShieldCheck/);
  assert.doesNotMatch(turnstile, /overflow-hidden/);

  assert.match(courseActions, /data-course-material-actions/);
  assert.match(courseActions, /grid w-full gap-3/);
  assert.match(courseActions, /className="w-full"/);
  assert.doesNotMatch(courseActions, /min-h-\[100dvh\]|pb-24|overflow-x/);
});
