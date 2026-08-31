import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('public Supabase reads have a bounded abortable upstream deadline', async () => {
  const [publicClient, upstream] = await Promise.all([
    read('lib/supabase/public.ts'),
    read('lib/content/upstream.ts'),
  ]);

  assert.match(publicClient, /global: \{ fetch: contentUpstreamFetch \}/);
  assert.match(upstream, /DEFAULT_CONTENT_DEADLINE_MS = 4_000/);
  assert.match(upstream, /Math\.min\(MAX_CONTENT_DEADLINE_MS/);
  assert.match(upstream, /AbortSignal\.any/);
  assert.match(upstream, /clearTimeout\(timeout\)/);
  assert.match(upstream, /name = 'TimeoutError'/);
});

test('article and topic reads share tagged, time-bounded caches with bounded stale state', async () => {
  const [articles, topics, policy] = await Promise.all([
    read('lib/content/articles.ts'),
    read('lib/content/topics.ts'),
    read('lib/content/cache-policy.ts'),
  ]);

  for (const source of [articles, topics]) {
    assert.match(source, /unstable_cache/);
    assert.match(source, /CONTENT_CACHE_REVALIDATE_SECONDS/);
    assert.match(source, /CONTENT_CACHE_TAG/);
    assert.match(source, /\.size > 128/);
  }
  assert.match(topics, /tests!tests_current_revision_fk!inner\(status\)/);
  assert.equal(
    topics.match(/\.eq\('test\.status', 'published'\)/g)?.length,
    2,
    'the canonical list and detail reads stay publication-filtered',
  );
  assert.doesNotMatch(topics, /isV3SchemaUnavailable|rolling-deploy legacy topics/);
  assert.match(policy, /CONTENT_CACHE_REVALIDATE_SECONDS = 5 \* 60/);
});

test('publishing invalidates every content consumer and supports a signed dashboard webhook', async () => {
  const [actions, adminServer, webhook, policy] = await Promise.all([
    read('lib/actions/articles.ts'),
    read('features/admin/server.ts'),
    read('app/api/content/revalidate/route.ts'),
    read('lib/content/cache-policy.ts'),
  ]);

  assert.match(actions, /updateTag\(CONTENT_CACHE_TAG\)/);
  assert.match(actions, /updateTag\(ARTICLES_CACHE_TAG\)/);
  assert.match(actions, /getArticleBySlug\(result\.slug\)/);
  const saveCourse = adminServer.slice(
    adminServer.indexOf('export async function saveTest'),
    adminServer.indexOf('export async function setTestStatus'),
  );
  assert.match(saveCourse, /if \(values\.publish\)[\s\S]*invalidateTestContent\(values\.slug\)/);
  assert.match(saveCourse, /invalidateTestContent\(previousPublishedSlug\)/);
  assert.doesNotMatch(saveCourse, /\n  invalidateTestContent\(values\.slug\);\n  return result/);
  assert.match(policy, /'\/sitemap\.xml'/);
  assert.match(webhook, /matchesBearerSecret/);
  assert.match(webhook, /CONTENT_REVALIDATE_SECRET/);
  assert.match(webhook, /revalidateTag\(CONTENT_CACHE_TAG, 'max'\)/);
});

test('static params and sitemap use the same published content APIs', async () => {
  const [articles, topics, articlePage, topicPage, testPage, sitemap] = await Promise.all([
    read('lib/content/articles.ts'),
    read('lib/content/topics.ts'),
    read('app/(public)/blog/[slug]/page.tsx'),
    read('app/(public)/topics/[slug]/page.tsx'),
    read('app/(account)/topics/[slug]/test/page.tsx'),
    read('app/sitemap.ts'),
  ]);

  assert.match(articles, /return \(await getArticles\(\)\)\.map/);
  assert.match(topics, /return \(await getTopics\(\)\)\.map/);
  for (const page of [articlePage, topicPage, testPage]) {
    assert.match(page, /export async function generateStaticParams/);
    assert.match(page, /await get(?:Article|Topic)Slugs\(\)/);
  }
  assert.match(sitemap, /await getTopics\(\)/);
  assert.match(sitemap, /await getArticles\(\)/);
});
