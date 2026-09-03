import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contentSeoSchema } from '../../lib/validation/content-seo.ts';
import {
  courseSeoDefaults,
  withCourseSeoDefaults,
} from '../../lib/validation/course-seo-defaults.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = async (relativePath) =>
  JSON.parse(await readFile(path.join(repositoryRoot, relativePath), 'utf8'));

const SLUGS = [
  'plotnik',
  'armaturshchik',
  'biot',
  'lesomontazhnye-raboty',
  'pozharnaya-bezopasnost',
];

async function courseWording(slug, locale) {
  if (locale === 'ru') {
    const course = await readJson(`content/snapshots/courses/${slug}/course.json`);
    return { title: course.title, description: course.description };
  }
  const draft = await readJson(
    `content/localizations/staged-2026-09-01/courses/${slug}/${locale}/course-draft.json`,
  );
  return { title: draft.title, description: draft.description };
}

test('every course gets a publishable SEO block in every language', async () => {
  // Courses were created before SEO existed, so the stored block was `{}` for
  // all five in all four languages: blank fields, publication refused, and a
  // bare one-word title on the public pages. The defaults have to satisfy the
  // same schema publication checks against, for real course wording.
  for (const slug of SLUGS) {
    for (const locale of ['ru', 'kk', 'en', 'zh']) {
      const { title, description } = await courseWording(slug, locale);
      const seo = withCourseSeoDefaults(locale, title, description, {});
      const parsed = contentSeoSchema.safeParse(seo);
      assert.ok(
        parsed.success,
        `${slug}/${locale}: ${JSON.stringify(parsed.error?.issues ?? [])}`,
      );
      assert.ok(seo.title.includes(title.trim()), `${slug}/${locale} title drops the course name`);
      assert.equal(seo.ogTitle, seo.title);
      assert.equal(seo.ogDescription, seo.description);
      assert.equal(seo.indexable, true);
    }
  }
});

test('a course with no wording at all still yields a valid block', () => {
  // The point of the defaults is that the form is never blank, so the degenerate
  // case must not fall back to an unpublishable block.
  for (const locale of ['ru', 'kk', 'en', 'zh']) {
    const parsed = contentSeoSchema.safeParse(courseSeoDefaults(locale, '', ''));
    assert.ok(parsed.success, `${locale}: ${JSON.stringify(parsed.error?.issues ?? [])}`);
  }
});

test('an overlong title or description is trimmed to the publishable limits', () => {
  const seo = courseSeoDefaults('ru', 'Т'.repeat(120), 'О'.repeat(400));
  const parsed = contentSeoSchema.safeParse(seo);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues ?? []));
  assert.ok(seo.title.length <= 70);
  assert.ok(seo.description.length <= 200);
});

test('anything an administrator has already written survives', () => {
  const stored = {
    title: 'Собственный заголовок',
    ogImage: '/images/blog/cover.jpg',
    indexable: false,
  };
  const seo = withCourseSeoDefaults('ru', 'Плотник', 'Описание курса', stored);
  assert.equal(seo.title, stored.title);
  assert.equal(seo.ogImage, stored.ogImage);
  assert.equal(seo.indexable, false);
  // Only the gaps are filled, and they still come from the course's own wording.
  assert.match(seo.description, /Описание курса/u);
  assert.notEqual(seo.ogTitle, '');
});

test('each language keeps its own wording rather than a Russian fallback', () => {
  const kk = courseSeoDefaults('kk', 'Ағаш шебері', 'Ағаш ұстасының қауіпсіз жұмыс тәжірибесі.');
  const zh = courseSeoDefaults('zh', '木匠', '安全木匠工作实践：工作场所组织、手动和电动工具。');
  const en = courseSeoDefaults('en', 'Carpenter', 'Safe carpenter work practices and tools.');
  assert.match(kk.title, /онлайн оқыту/u);
  assert.match(zh.title, /在线培训/u);
  assert.match(en.title, /online training/u);
  for (const seo of [kk, zh, en]) {
    assert.doesNotMatch(seo.description, /Практический материал SafetyHub/u);
  }
});
