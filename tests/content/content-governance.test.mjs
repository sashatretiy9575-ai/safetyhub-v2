import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const slugs = [
  'plotnik',
  'armaturshchik',
  'lesomontazhnye-raboty',
  'biot',
  'pozharnaya-bezopasnost',
];

test('public learning copy consistently describes ten-question tests', async () => {
  const [hero, testimonials, partners, ru] = await Promise.all([
    read('components/marketing/hero.tsx'),
    read('components/marketing/testimonials.tsx'),
    read('components/marketing/partners-strip.tsx'),
    read('messages/ru.json').then(JSON.parse),
  ]);
  const publicCopy = `${hero}\n${testimonials}\n${partners}`;
  assert.doesNotMatch(publicCopy, /пятью понятными вопросами/iu);
  assert.match(testimonials, /t\('managerAction'\)/u);
  assert.match(ru.Home.cases.managerAction, /десятью понятными вопросами/iu);
  assert.match(ru.Home.hero.description, /10 вопросов/iu);
});

test('the local course snapshot contains only the five canonical presentation courses', async () => {
  const courses = await Promise.all(
    slugs.map(async (slug) =>
      JSON.parse(await read(`content/snapshots/courses/${slug}/course.json`)),
    ),
  );
  assert.deepEqual(
    courses.map((course) => course.slug),
    slugs,
  );
  assert.deepEqual(
    courses.map((course) => course.displayOrder),
    [1, 2, 3, 4, 5],
  );
  assert.equal(
    courses.reduce((total, course) => total + course.presentation.pageCount, 0),
    198,
  );
  assert.equal(
    courses.reduce((total, course) => total + course.variants.length, 0),
    15,
  );
  for (const course of courses) {
    assert.equal(course.policy.durationMinutes, 15);
    assert.equal(course.policy.passScore, 7);
    assert.equal(course.policy.questionCount, 10);
    assert.equal(course.policy.variantCount, 3);
    assert.equal(course.policy.attemptsPerCalendarDay, 8);
    assert.equal(course.policy.resetTimezone, 'Asia/Oral');
    assert.equal(course.presentation.aspectRatio, '16:9');
    assert.match(course.presentation.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      course.variants.every((variant) => variant.questions.length === 10),
      true,
    );
    assert.equal(
      course.variants.every((variant) =>
        variant.questions.every(
          (question) =>
            question.options.length === 4 &&
            question.options.some((option) => option.id === question.correctOptionId),
        ),
      ),
      true,
    );
  }
});

test('public course page offers presentation download before the test and preserves redirects', async () => {
  const [topicPage, actions, topicSource, nextConfig] = await Promise.all([
    read('app/(public)/topics/[slug]/page.tsx'),
    read('components/topics/course-material-actions.tsx'),
    read('lib/content/topics.ts'),
    read('next.config.ts'),
  ]);
  assert.ok(topicPage.indexOf('<CourseMaterialActions') < topicPage.indexOf('<TopicSourcesCard'));
  assert.match(topicPage, /fire-safety.+pozharnaya-bezopasnost/su);
  assert.match(topicPage, /occupational-health.+biot/su);
  assert.match(topicPage, /industrial-safety.+topics/su);
  assert.match(
    nextConfig,
    /source: '\/topics\/fire-safety'.+destination: '\/topics\/pozharnaya-bezopasnost'.+permanent: true/su,
  );
  assert.match(
    nextConfig,
    /source: '\/topics\/occupational-health'.+destination: '\/topics\/biot'.+permanent: true/su,
  );
  assert.match(
    nextConfig,
    /source: '\/topics\/industrial-safety'.+destination: '\/topics'.+permanent: true/su,
  );
  assert.ok(
    actions.indexOf("t('downloadPresentation')") < actions.indexOf("t('startTest')"),
  );
  assert.match(actions, /download=\$\{encodeURIComponent/);
  assert.match(actions, /download=\{filename\}/);
  assert.match(actions, /localizePathname\(ROUTES\.test\(course\.slug\), locale\)/);
  assert.doesNotMatch(actions, /pdfjs-dist|canvas|iframe|PageUp|PageDown/);
  assert.match(topicSource, /course-presentations/);
  assert.doesNotMatch(topicPage, /TopicViewer/);
  assert.match(topicPage, /course=\{topic\}/);
  assert.doesNotMatch(topicPage, /CoursePresentationViewer/);
  assert.doesNotMatch(topicPage, /LegacyCourseViewer|legacySlides/);
  assert.doesNotMatch(topicSource, /isV3SchemaUnavailable|LegacyPublicCourseRecord/);
  assert.doesNotMatch(topicSource, /getLegacyTopicsFromSource|legacySlidesFromContent/);
  assert.match(topicSource, /fallback: \(\) => lastKnownTopics \?\? \[\]/);
  assert.doesNotMatch(topicSource, /fallback: \(\) => lastKnownTopics \?\? localTopics/);
  assert.doesNotMatch(topicSource, /\.eq\('presentation\.status', 'ready'\)/);
});

test('admin course surface uses v3 publication without loading saved answer keys', async () => {
  const [adminPage, editor, server, editPage, route] = await Promise.all([
    read('app/(admin)/admin/courses/page.tsx'),
    read('components/admin/test-editor.tsx'),
    read('features/admin/server.ts'),
    read('app/(admin)/admin/courses/[id]/page.tsx'),
    read('app/api/admin/courses/route.ts'),
  ]);
  assert.match(adminPage, /Черновик/);
  assert.match(adminPage, /Опубликован/);
  assert.match(adminPage, /Есть черновик/);
  assert.match(editor, /<CoursePresentationInput/);
  assert.match(editor, /Вариант \{variant\.variantNumber\}/);
  assert.match(server, /getTestEditorSeed/);
  assert.match(editPage, /getTestEditorSeed/);
  assert.doesNotMatch(server, /get_course_editor_payload_v3/);
  assert.doesNotMatch(editPage, /getTestEditorPayload|TestEditorPayload/);
  assert.doesNotMatch(editor, /readTestEditorDraft|writeTestEditorDraft|clearTestEditorDraft/);
  assert.match(server, /save_course_draft_v3/);
  assert.match(server, /save_and_publish_course_v3/);
  assert.match(route, /saveTestSchema/);
  assert.match(route, /invalidOriginResponse/);
  assert.doesNotMatch(editor, /CourseContentEditor|reviewReady|reviewedContentHash/);
});

test('learner payload parsing rejects hidden variant identifiers and all answer-key fields', async () => {
  const [learning, types] = await Promise.all([
    read('features/learning/server.ts'),
    read('features/learning/types.ts'),
  ]);
  assert.match(learning, /\.strict\(\)/);
  assert.doesNotMatch(types, /variantId|variantNumber/);
  assert.doesNotMatch(learning, /variantId|variantNumber/);
  assert.doesNotMatch(types, /correctOptionId|isCorrect|review:/);
  assert.doesNotMatch(
    learning,
    /correctOptionId|test_revision_variant_answer_keys|reviewItemSchema/,
  );
});
