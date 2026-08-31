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

  assert.match(courses, /await getTopics\(\)/);
  assert.doesNotMatch(courses, /const TOPICS =/);
  assert.match(courses, /getCourseCoverImage\(topic\.slug\)/);
  assert.match(catalog, /getCourseCoverImage\(topic\.slug\)/);
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
  assert.match(resources, /await getArticles\(\)/);
  assert.doesNotMatch(resources, /const POSTS =/);
  assert.match(resources, /coverImage=\{post\.coverImage\}/);
});

test('homepage streams its useful choices first and removes duplicate promise sections', async () => {
  const page = await read('app/(public)/page.tsx');

  const coursePosition = page.indexOf('<CourseGrid />');
  const trustPosition = page.indexOf('<PartnersStrip />');
  assert.ok(coursePosition > 0 && coursePosition < trustPosition);
  assert.match(page, /Suspense fallback=\{<HomeSectionFallback label="Загружаем курсы"/);
  assert.doesNotMatch(page, /<ResultsNumbers \/>/);
  assert.doesNotMatch(page, /<BenefitGrid \/>/);
});

test('onboarding presents the approved three-step course journey', async () => {
  const source = await read('components/marketing/process-timeline.tsx');
  const choose = source.indexOf("title: 'Выберите курс'");
  const learn = source.indexOf("title: 'Изучите материал'");
  const result = source.indexOf("title: 'Сохраните результат'");

  assert.ok(choose >= 0 && choose < learn && learn < result);
  assert.match(source, /QUIZ_POLICY\.questionCount/);
  assert.doesNotMatch(source, /Войдите для теста/);
});

test('public learning choices stay concise and action-first while FAQ starts collapsed', async () => {
  const [courseCard, courseGrid, courseCatalog, faq] = await Promise.all([
    read('components/marketing/course-card.tsx'),
    read('components/marketing/course-grid.tsx'),
    read('app/(public)/topics/page.tsx'),
    read('components/marketing/faq-accordion.tsx'),
  ]);

  const imagePosition = courseCard.indexOf('<Image');
  const questionCountPosition = courseCard.indexOf('${questionCount} вопросов');
  const actionPosition = courseCard.lastIndexOf('Открыть курс');

  assert.ok(imagePosition >= 0 && imagePosition < questionCountPosition);
  assert.ok(questionCountPosition < actionPosition);
  assert.match(courseCard, /bg-\[var\(--color-primary\)\]/);
  assert.match(courseCard, /data-course-card-cta/);
  assert.match(courseCard, /grid-cols-2/);
  assert.match(courseCard, /col-span-2/);
  assert.doesNotMatch(courseCard, /Открыть\s*<\/span>/);
  assert.doesNotMatch(courseCard, /description:\s*string|\{description\}|line-clamp-3/);
  assert.doesNotMatch(courseGrid, /description=\{topic\.description\}/);
  assert.doesNotMatch(courseCatalog, /description=\{topic\.description\}/);

  const detailTags = [...faq.matchAll(/<details[\s\S]*?>/g)].map(([tag]) => tag);
  assert.ok(detailTags.length > 0);
  for (const tag of detailTags) {
    assert.doesNotMatch(tag, /\sopen(?:\s|=|>)/);
  }
});
