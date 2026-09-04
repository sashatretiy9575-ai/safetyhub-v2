import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('homepage topics and resources use the shared published content APIs', async () => {
  const [courses, catalog, resources, covers] = await Promise.all([
    read('components/marketing/course-grid.tsx'),
    read('app/(public)/topics/page.tsx'),
    read('components/marketing/resources.tsx'),
    read('lib/course-cover-images.ts'),
  ]);

  assert.match(courses, /await getTopics\(locale\)/);
  assert.doesNotMatch(courses, /const TOPICS =/);
  assert.match(courses, /getCourseCoverImage\(topic\.slug, topic\.seo\.ogImage\)/);
  assert.match(catalog, /getCourseCoverImage\(topic\.slug, topic\.seo\.ogImage\)/);
  assert.doesNotMatch(`${courses}\n${catalog}`, /presentation\?\.thumbnailUrl/);
  for (const slug of [
    'plotnik',
    'armaturshchik',
    'lesomontazhnye-raboty',
    'biot',
    'pozharnaya-bezopasnost',
  ]) {
    assert.match(covers, new RegExp(`['\"]?${slug}['\"]?:`));
  }
  assert.match(resources, /await getArticles\(locale\)/);
  assert.doesNotMatch(resources, /const POSTS =/);
  assert.match(resources, /coverImage=\{post\.coverImage\}/);
});

test('homepage streams its useful choices first and removes duplicate promise sections', async () => {
  const page = await read('app/(public)/page.tsx');

  const coursePosition = page.indexOf('<CourseGrid />');
  const trustPosition = page.indexOf('<PartnersStrip />');
  assert.ok(coursePosition > 0 && coursePosition < trustPosition);
  assert.match(page, /Suspense fallback=\{<HomeSectionFallback label=\{t\('loadingCourses'\)\}/);
  assert.doesNotMatch(page, /<ResultsNumbers \/>/);
  assert.doesNotMatch(page, /<BenefitGrid \/>/);
});

test('onboarding presents the approved three-step course journey', async () => {
  const source = await read('components/marketing/process-timeline.tsx');
  const choose = source.indexOf("title: t('chooseTitle')");
  const learn = source.indexOf("title: t('learnTitle')");
  const result = source.indexOf("title: t('resultTitle')");

  assert.ok(choose >= 0 && choose < learn && learn < result);
  assert.match(source, /QUIZ_POLICY\.questionCount/);
  assert.doesNotMatch(source, /[\u0400-\u04ff]/u);
});

test('public learning choices stay concise and action-first while FAQ starts collapsed', async () => {
  const [courseCard, courseGrid, courseCatalog, faq] = await Promise.all([
    read('components/marketing/course-card.tsx'),
    read('components/marketing/course-grid.tsx'),
    read('app/(public)/topics/page.tsx'),
    read('components/marketing/faq-accordion.tsx'),
  ]);

  const imagePosition = courseCard.indexOf('<Image');
  const questionCountPosition = courseCard.indexOf("t('questions'");
  const actionPosition = courseCard.lastIndexOf("t('open')");

  assert.ok(imagePosition >= 0 && imagePosition < questionCountPosition);
  assert.ok(questionCountPosition < actionPosition);
  assert.match(courseCard, /bg-\[var\(--color-primary\)\]/);
  assert.match(courseCard, /data-course-card-cta/);
  assert.match(courseCard, /grid-cols-2/);
  assert.match(courseCard, /col-span-2/);
  assert.doesNotMatch(courseCard, /[\u0400-\u04ff]/u);
  assert.doesNotMatch(courseCard, /description:\s*string|\{description\}|line-clamp-3/);
  assert.doesNotMatch(courseGrid, /description=\{topic\.description\}/);
  assert.doesNotMatch(courseCatalog, /description=\{topic\.description\}/);

  const detailTags = [...faq.matchAll(/<details[\s\S]*?>/g)].map(([tag]) => tag);
  assert.ok(detailTags.length > 0);
  for (const tag of detailTags) {
    assert.doesNotMatch(tag, /\sopen(?:\s|=|>)/);
  }
});
