import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { contentSeoSchema, defaultContentSeo } from '../../lib/validation/content-seo.ts';
import { articleSeoDefaults } from '../../lib/validation/article-seo-defaults.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUSSIAN_FILLER = /Материал SafetyHub|Практический материал/u;

test('a translated article page never falls back to Russian SEO wording', () => {
  // Five published Chinese articles store a summary of 34–39 characters. The
  // generic default pads anything under 40 with a Russian sentence, so their
  // meta description ended in Russian on a Chinese page.
  const zhSummary = '高处作业前检查安全带、锚点与防坠落系统的要点。';
  assert.ok(zhSummary.length < 40);
  for (const [locale, title, description] of [
    ['zh', '高处作业', zhSummary],
    ['kk', 'Биіктегі жұмыс', 'Қысқа сипаттама.'],
    ['en', 'Work at height', 'Short summary.'],
  ]) {
    const seo = articleSeoDefaults(locale, title, description);
    assert.equal(contentSeoSchema.safeParse(seo).success, true, locale);
    for (const value of [seo.title, seo.description, seo.ogTitle, seo.ogDescription]) {
      assert.doesNotMatch(value, RUSSIAN_FILLER, `${locale}: ${value}`);
    }
  }
  // A two-character Chinese title used to become «Материал SafetyHub».
  assert.doesNotMatch(articleSeoDefaults('zh', '焊接', '').title, RUSSIAN_FILLER);
  assert.equal(articleSeoDefaults('zh', '高处作业', zhSummary).title, '高处作业');
});

test('the Russian article page keeps the wording it always had', () => {
  const generic = defaultContentSeo('Наряд-допуск', 'Короткое описание.', 'cover.webp');
  assert.match(generic.description, RUSSIAN_FILLER);
  assert.equal(articleSeoDefaults('ru', 'Наряд-допуск', 'Короткое описание.').description.includes('Практический материал'), true);
});

test('the localized article reader routes its fallback through the locale', async () => {
  const articles = await readFile(path.join(repositoryRoot, 'server/content/articles.ts'), 'utf8');
  assert.match(
    articles,
    /locale === DEFAULT_LOCALE\s*\?\s*defaultContentSeo\(title, description, ogImage\)\s*:\s*articleSeoDefaults\(locale, title, description, ogImage\)/u,
  );
  assert.match(
    articles,
    /seo: articleSeo\(value\.seo, value\.title, value\.description, coverImage, locale\)/u,
  );
});
