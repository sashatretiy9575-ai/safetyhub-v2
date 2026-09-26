import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  courseAssessmentGaps,
  courseLocaleBlockers,
  courseLocaleGaps,
  courseLocaleState,
  coursePublicationBlockers,
  looksRussian,
} from '../../lib/admin/course-readiness.ts';
import { assessmentProjection } from '../../scripts/content/publish-course-batch.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BATCH = 'content/course-batch-2026-09';
const SLUGS = ['svarshchik', 'promyshlennaya-bezopasnost'];
const LOCALES = ['ru', 'kk', 'en', 'zh'];

const readJson = async (...segments) =>
  JSON.parse(await readFile(path.join(repositoryRoot, BATCH, ...segments), 'utf8'));

/** What the database keeps for the Russian row: texts and positions, no explanations. */
function russianStoredSets(variants) {
  return variants.map((variant) => ({
    id: variant.id,
    variantNumber: variant.variantNumber,
    questions: variant.questions.map((question, index) => ({
      id: question.id,
      text: question.text,
      position: index + 1,
      options: question.options.map((option, position) => ({
        id: option.id,
        text: option.text,
        position: position + 1,
      })),
    })),
  }));
}

function explainedIds(variants) {
  return new Set(
    variants.flatMap((variant) =>
      variant.questions.filter((question) => question.explanation.trim()).map(({ id }) => id),
    ),
  );
}

/**
 * The saved state of one course as the editor's server read reports it, built
 * from the batch files the same way the batch publisher stores them.
 */
async function loadCourse(slug, { status = 'published', mutate } = {}) {
  const sources = {};
  for (const locale of LOCALES) {
    sources[locale] = {
      deck: await readJson(slug, locale, 'deck.json'),
      variants: (await readJson(slug, locale, 'assessment.json')).variants,
    };
  }
  mutate?.(sources);
  const russian = {
    stored: russianStoredSets(sources.ru.variants),
    explainedIds: explainedIds(sources.ru.variants),
  };
  return LOCALES.map((locale) => {
    const { deck, variants } = sources[locale];
    const stored = locale === 'ru' ? russian.stored : assessmentProjection(variants);
    return {
      locale,
      status,
      title: deck.title,
      description: deck.description,
      seoStored: { title: deck.seo.title, description: deck.seo.description },
      presentation: { status: 'ready' },
      assessmentImported: locale !== 'ru',
      assessmentGaps: courseAssessmentGaps(locale, stored, russian),
    };
  });
}

const factsOf = (all, locale) => all.find((facts) => facts.locale === locale);
const gapsOf = (all, locale) => courseLocaleGaps(factsOf(all, locale), factsOf(all, 'ru'));
const labelOf = (all, locale) => courseLocaleState(factsOf(all, locale), gapsOf(all, locale)).label;

function stripExplanations(variants, keep = 0) {
  let seen = 0;
  for (const variant of variants) {
    for (const question of variant.questions) {
      seen += 1;
      if (seen > keep) question.explanation = '';
    }
  }
}

test('both batch courses have no gaps in any of their eight language versions', async () => {
  for (const slug of SLUGS) {
    const published = await loadCourse(slug);
    for (const locale of LOCALES) {
      assert.deepEqual(gapsOf(published, locale), [], `${slug}/${locale}`);
      assert.equal(labelOf(published, locale), 'Опубликовано', `${slug}/${locale}`);
      // Only counts leave the server: no text or identifier rides along.
      assert.deepEqual(factsOf(published, locale).assessmentGaps, {
        total: 30,
        emptyTexts: 0,
        missingExplanations: 0,
        russianTexts: 0,
      });
    }
    assert.deepEqual(coursePublicationBlockers(published), []);

    const complete = await loadCourse(slug, { status: 'complete' });
    for (const locale of LOCALES) {
      assert.equal(labelOf(complete, locale), 'Готово к публикации', `${slug}/${locale}`);
    }
  }
});

test('explanations are checked as parity with the Russian source', async () => {
  const stripped = await loadCourse('svarshchik', {
    mutate: (sources) => stripExplanations(sources.zh.variants),
  });
  assert.deepEqual(gapsOf(stripped, 'zh'), ['В китайской версии нет пояснений к вопросам']);
  assert.equal(labelOf(stripped, 'zh'), 'Опубликовано не полностью');
  for (const locale of ['ru', 'kk', 'en']) assert.deepEqual(gapsOf(stripped, locale), []);
  assert.deepEqual(coursePublicationBlockers(stripped), [
    'В китайской версии нет пояснений к вопросам',
  ]);

  const partly = await loadCourse('svarshchik', {
    mutate: (sources) => stripExplanations(sources.en.variants, 27),
  });
  assert.deepEqual(gapsOf(partly, 'en'), ['В английской версии нет пояснений к 3 вопросам']);
  const one = await loadCourse('svarshchik', {
    mutate: (sources) => stripExplanations(sources.kk.variants, 29),
  });
  assert.deepEqual(gapsOf(one, 'kk'), ['В казахской версии нет пояснений к 1 вопросу']);

  // The five older courses were written without explanations: nothing is
  // missing where Russian has nothing either.
  const neverExplained = await loadCourse('promyshlennaya-bezopasnost', {
    mutate: (sources) => {
      for (const locale of LOCALES) stripExplanations(sources[locale].variants);
    },
  });
  for (const locale of LOCALES) assert.deepEqual(gapsOf(neverExplained, locale), []);

  // An unreadable Russian bank skips the check instead of guessing.
  const zh = (await readJson('svarshchik', 'zh', 'assessment.json')).variants;
  stripExplanations(zh);
  assert.equal(
    courseAssessmentGaps('zh', assessmentProjection(zh), { stored: null, explainedIds: null })
      .missingExplanations,
    0,
  );
});

test('a version with only its title translated never reads as published or ready', async () => {
  for (const locale of ['kk', 'en', 'zh']) {
    for (const status of ['published', 'complete']) {
      const course = await loadCourse('promyshlennaya-bezopasnost', {
        status,
        mutate: (sources) => {
          const title = sources[locale].deck.title;
          sources[locale] = structuredClone(sources.ru);
          sources[locale].deck.title = title;
        },
      });
      assert.deepEqual(gapsOf(course, locale), [
        `В ${{ kk: 'казахской', en: 'английской', zh: 'китайской' }[locale]} версии остался русский текст: описание, SEO, вопросы`,
      ]);
      assert.equal(
        labelOf(course, locale),
        status === 'published' ? 'Опубликовано не полностью' : 'Не готово',
      );
      assert.equal(factsOf(course, locale).assessmentGaps.russianTexts > 0, true);
      // Russian itself is never held to this rule.
      assert.deepEqual(gapsOf(course, 'ru'), []);
    }
  }
});

test('the Russian-text rule spares Kazakh wording and catches Russian pasted elsewhere', async () => {
  const russianQuestion = 'Что следует сделать при неясном требовании к сварному соединению?';
  assert.equal(looksRussian('en', russianQuestion, []), true);
  assert.equal(looksRussian('zh', russianQuestion, []), true);
  assert.equal(looksRussian('ru', russianQuestion, [russianQuestion]), false);
  // Kazakh is Cyrillic: only a long string identical to the Russian one counts.
  assert.equal(looksRussian('kk', russianQuestion, [russianQuestion]), true);
  assert.equal(looksRussian('kk', russianQuestion, []), false);
  assert.equal(looksRussian('kk', 'БИОТ', ['БИОТ']), false);
  assert.equal(
    looksRussian(
      'kk',
      'Дәнекерлеушілер курсы: қосылысты дайындау, жабдық, электр және өрт қауіптері.',
      [russianQuestion],
    ),
    false,
  );
  // A quoted standard or an abbreviation does not make a translation Russian.
  assert.equal(looksRussian('en', 'Wear the PPE (СИЗ) listed in the permit to work', []), false);
  assert.equal(looksRussian('zh', '按照 ГОСТ 12.0.004 的要求组织安全培训和考核', []), false);

  // Every real Kazakh text of both courses passes, all 360 of them.
  for (const slug of SLUGS) {
    assert.equal(factsOf(await loadCourse(slug), 'kk').assessmentGaps.russianTexts, 0);
  }

  const pasted = await loadCourse('svarshchik', {
    mutate: (sources) => {
      sources.en.variants[0].questions[0].text = sources.ru.variants[0].questions[0].text;
      sources.zh.deck.seo.title = sources.ru.deck.seo.description;
    },
  });
  assert.equal(factsOf(pasted, 'en').assessmentGaps.russianTexts, 1);
  assert.deepEqual(gapsOf(pasted, 'en'), ['В английской версии остался русский текст: вопросы']);
  assert.deepEqual(gapsOf(pasted, 'zh'), ['В китайской версии остался русский текст: SEO']);
});

test('every missing part is named, and an empty module list or cover is not one', async () => {
  const course = await loadCourse('svarshchik', { status: 'complete' });
  const kk = factsOf(course, 'kk');
  const broken = {
    ...kk,
    title: ' ',
    description: '',
    seoStored: { title: '', description: '' },
    presentation: { status: 'validating' },
    assessmentGaps: { total: 20, emptyTexts: 4, missingExplanations: 0, russianTexts: 0 },
  };
  assert.deepEqual(courseLocaleGaps(broken, factsOf(course, 'ru')), [
    'В казахской версии нет названия',
    'В казахской версии нет описания',
    'В казахской версии презентация ещё проверяется',
    'В казахской версии вопросов 20 из 30',
    'В казахской версии есть вопросы или ответы без текста: 4',
    'В казахской версии не заполнен SEO-заголовок',
    'В казахской версии не заполнено SEO-описание',
  ]);
  // Under the language's own tab the lines do not name the language again.
  assert.deepEqual(courseLocaleGaps(broken, factsOf(course, 'ru'), 'bare').slice(0, 3), [
    'Нет названия',
    'Нет описания',
    'Презентация ещё проверяется',
  ]);
  assert.deepEqual(courseLocaleGaps({ ...kk, presentation: null }, null), [
    'В казахской версии нет презентации',
  ]);
  assert.deepEqual(courseLocaleGaps({ ...kk, presentation: { status: 'rejected' } }, null), [
    'В казахской версии презентация отклонена',
  ]);
  // A translation whose bank was never imported still holds the Russian
  // placeholder: it has no questions of its own, whatever the placeholder says.
  for (const unimported of [
    { ...kk, assessmentImported: false },
    { ...kk, assessmentGaps: null },
    { ...kk, assessmentGaps: { ...kk.assessmentGaps, total: 0 } },
  ]) {
    assert.deepEqual(courseLocaleGaps(unimported, null), [
      'В казахской версии нет вопросов и ответов',
    ]);
  }
  // The facts carry neither modules nor a cover, so neither can become a gap.
  assert.deepEqual(Object.keys(kk).sort(), [
    'assessmentGaps',
    'assessmentImported',
    'description',
    'locale',
    'presentation',
    'seoStored',
    'status',
    'title',
  ]);
});

test('states and publication blockers follow the saved rows', async () => {
  const course = await loadCourse('svarshchik', { status: 'complete' });
  const withLocale = (locale, change) =>
    course.map((facts) => (facts.locale === locale ? { ...facts, ...change } : facts));
  const state = (all, locale) => courseLocaleState(factsOf(all, locale), gapsOf(all, locale));

  const draft = withLocale('zh', { status: 'draft' });
  assert.equal(state(draft, 'zh').label, 'Черновик');
  assert.deepEqual(coursePublicationBlockers(draft), ['Китайская версия не отмечена готовой']);

  const unsaved = withLocale('zh', { status: 'published', unsaved: true });
  assert.equal(state(unsaved, 'zh').label, 'Не сохранено');
  assert.deepEqual(coursePublicationBlockers(unsaved), [
    'Китайская версия: есть несохранённые изменения',
  ]);

  const missing = withLocale('en', { status: 'missing', title: '', description: '' });
  assert.equal(state(missing, 'en').label, 'Не заполнено');
  assert.deepEqual(courseLocaleBlockers(missing).en, ['Английская версия не заполнена']);
  // A locale the server did not return at all is missing too.
  assert.deepEqual(coursePublicationBlockers(course.filter((facts) => facts.locale !== 'kk')), [
    'Казахская версия не заполнена',
  ]);

  const gapAndDraft = withLocale('kk', { status: 'draft', description: '' });
  assert.equal(state(gapAndDraft, 'kk').label, 'Не готово');
  assert.deepEqual(courseLocaleBlockers(gapAndDraft).kk, [
    'В казахской версии нет описания',
    'Казахская версия не отмечена готовой',
  ]);
  assert.deepEqual(
    Object.values(courseLocaleBlockers(gapAndDraft)).flat(),
    coursePublicationBlockers(gapAndDraft),
  );
});
