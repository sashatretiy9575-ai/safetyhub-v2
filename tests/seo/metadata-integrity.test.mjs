import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Open Graph and structured-data image URLs point to real application assets', async () => {
  const [seo, image] = await Promise.all([read('lib/seo.ts'), read('app/opengraph-image.tsx')]);

  assert.doesNotMatch(seo, /\/og\.png|\/logo\.svg/);
  assert.match(seo, /ogImage = '\/opengraph-image'/);
  assert.match(seo, /\/icons\/icon-512x512\.png/);
  assert.match(image, /width: 1200, height: 630/);
  assert.match(image, /contentType = 'image\/png'/);
});

test('JSON-LD describes only visible capabilities and is mounted on matching pages', async () => {
  const [seo, home, courseGrid, article, topic] = await Promise.all([
    read('lib/seo.ts'),
    read('app/(public)/page.tsx'),
    read('components/marketing/course-grid.tsx'),
    read('app/(public)/blog/[slug]/page.tsx'),
    read('app/(public)/topics/[slug]/page.tsx'),
  ]);

  assert.doesNotMatch(seo, /SearchAction|search_term_string/);
  assert.match(home, /faqJsonLd\(FAQ_DATA\)/);
  assert.match(courseGrid, /courseJsonLd/);
  assert.match(article, /articleJsonLd/);
  assert.match(article, /breadcrumbsJsonLd/);
  assert.match(topic, /courseJsonLd/);
  assert.match(topic, /breadcrumbsJsonLd/);
});

test('sitemap uses every published source row and stable content timestamps', async () => {
  const [sitemap, topics, articles, actions, policy] = await Promise.all([
    read('app/sitemap.ts'),
    read('lib/content/topics.ts'),
    read('lib/content/articles.ts'),
    read('lib/actions/articles.ts'),
    read('lib/content/cache-policy.ts'),
  ]);

  assert.match(sitemap, /getTopics\(\)/);
  assert.doesNotMatch(sitemap, /getTopicSlugs/);
  assert.doesNotMatch(sitemap, /const now = new Date\(\)/);
  assert.match(sitemap, /topic\.updatedAt/);
  assert.match(sitemap, /p\.updatedAt \?\? p\.createdAt/);
  assert.match(topics, /description,icon,[^'\r\n]*seo,published_at/);
  assert.match(articles, /created_at,updated_at/);
  assert.match(actions, /CONTENT_REVALIDATE_PATHS/);
  assert.match(policy, /'\/sitemap\.xml'/);
});

test('deployment URLs fail closed and previews cannot be indexed', async () => {
  const [siteUrl, config, seo, robots, registerRoute] = await Promise.all([
    read('lib/site-url.ts'),
    read('next.config.ts'),
    read('lib/seo.ts'),
    read('app/robots.ts'),
    read('app/api/auth/register/route.ts'),
  ]);

  assert.match(siteUrl, /VERCEL_ENV === 'production'/);
  assert.match(siteUrl, /NEXT_PUBLIC_SITE_URL is required/);
  assert.match(siteUrl, /must use HTTPS/);
  assert.match(siteUrl, /PRODUCTION_SITE_ORIGIN = 'https:\/\/safetyhub\.kz'/);
  assert.match(siteUrl, /VERCEL_ENV === 'preview'/);
  assert.match(siteUrl, /VERCEL_URL/);
  assert.match(config, /assertDeploymentSiteUrl\(\)/);
  assert.match(seo, /noindex \|\| isPreviewDeployment\(\)/);
  assert.match(robots, /disallow: '\/'/);
  assert.match(registerRoute, /getSiteUrl\(\)\.replace/);
  assert.doesNotMatch(registerRoute, /new URL\(request\.url\)\.origin/);
  assert.doesNotMatch(registerRoute, /window\./);
});
