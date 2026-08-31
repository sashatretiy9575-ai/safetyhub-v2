import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');
const exists = (file) => existsSync(new URL(file, root));

test('learner courses use only canonical presentation-backed content', async () => {
  const [topics, topicPage] = await Promise.all([
    read('lib/content/topics.ts'),
    read('app/(public)/topics/[slug]/page.tsx'),
  ]);

  assert.equal(exists('components/topics/legacy-course-viewer.tsx'), false);
  assert.equal(exists('components/topics/course-presentation-viewer.tsx'), false);
  assert.doesNotMatch(topics, /LegacyCourseSlide|legacySlides|legacySlidesFromContent/);
  assert.doesNotMatch(topics, /legacyPublicCourseSelection|isV3SchemaUnavailable/);
  assert.doesNotMatch(topics, /content\/topics/);
  assert.doesNotMatch(topicPage, /LegacyCourseViewer|legacySlides/);
  assert.match(topicPage, /<CourseMaterialActions course=\{topic\}/);
  assert.doesNotMatch(topicPage, /CoursePresentationViewer/);
});

test('retired admin test aliases are absent after the canonical courses cutover', () => {
  for (const file of [
    'app/(admin)/admin/tests/page.tsx',
    'app/(admin)/admin/tests/new/page.tsx',
    'app/(admin)/admin/tests/[id]/page.tsx',
    'app/api/admin/tests/route.ts',
    'app/api/admin/tests/[testId]/route.ts',
    'app/api/admin/tests/[testId]/status/route.ts',
  ]) {
    assert.equal(exists(file), false, `${file} must stay retired`);
  }
});
