import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { COURSE_BATCH_LOCALES, COURSE_BATCH_SLUGS } from '../../scripts/publish-course-batch.mjs';
import {
  VERIFIED_LOCALES,
  VERIFIED_SLUGS,
  assertLocalSupabaseUrl,
  checkPublication,
  checkQuestions,
  checkTextAndSeo,
  comparableQuestions,
  createCheck,
  createReadOnlyFetch,
  cyrillicShare,
  findAnswerKeyPaths,
  russianLeftovers,
} from '../../scripts/verify-course-batch-local.mjs';

const HASH = 'a'.repeat(64);

function seo(title, description) {
  return {
    title,
    description,
    ogTitle: title,
    ogDescription: description,
    ogImage: '/images/course-batch/sample-en.webp',
    indexable: true,
  };
}

/** Three variants of ten four-option questions, as assessment.json holds them. */
function authoredBank() {
  return Array.from({ length: 3 }, (_, variantIndex) => ({
    id: randomUUID(),
    variantNumber: variantIndex + 1,
    questions: Array.from({ length: 10 }, (_, questionIndex) => {
      const options = Array.from({ length: 4 }, (_, optionIndex) => ({
        id: randomUUID(),
        text: `Option ${optionIndex + 1} of question ${variantIndex * 10 + questionIndex + 1}`,
        displayOrder: optionIndex + 1,
      }));
      return {
        id: randomUUID(),
        text: `Question number ${variantIndex * 10 + questionIndex + 1}?`,
        displayOrder: questionIndex + 1,
        options,
        correctOptionId: options[1].id,
        explanation: `Explanation ${variantIndex * 10 + questionIndex + 1}.`,
      };
    }),
  }));
}

/** The published rows of that bank for one translated language. */
function publishedBank(authored, locale = 'en') {
  const variants = authored.map((variant) => ({
    id: randomUUID(),
    stable_id: variant.id,
    variant_number: variant.variantNumber,
  }));
  const variantLocalizations = authored.map((variant, index) => ({
    variant_id: variants[index].id,
    locale,
    question_count: 10,
    structure_hash: HASH,
    questions: variant.questions.map((question, questionIndex) => ({
      id: question.id,
      text: question.text,
      displayOrder: questionIndex + 1,
      options: question.options.map(({ id, text, displayOrder }) => ({ id, text, displayOrder })),
    })),
    explanations: variant.questions.map((question) => question.explanation),
  }));
  return { variants, variantLocalizations };
}

const POLICY = {
  durationMinutes: 15,
  passScore: 7,
  questionCount: 10,
  attemptsPerCalendarDay: 8,
  resetTimezone: 'Asia/Oral',
};
const REVISION_POLICY = {
  duration_minutes: 15,
  pass_score: 7,
  question_count: 10,
  attempts_per_calendar_day: 8,
  attempt_reset_timezone: 'Asia/Oral',
};

function questionProblems(authored, published, locale = 'en') {
  const check = createCheck();
  checkQuestions({
    check,
    revision: REVISION_POLICY,
    ...published,
    assessment: { policy: POLICY, variants: authored },
    locale,
  });
  return check.problems;
}

test('the verifier covers exactly the courses and languages the publisher writes', () => {
  assert.deepEqual(VERIFIED_SLUGS, COURSE_BATCH_SLUGS);
  assert.deepEqual(VERIFIED_LOCALES, COURSE_BATCH_LOCALES);
});

test('only the local Supabase stand is accepted', () => {
  assert.equal(assertLocalSupabaseUrl('http://127.0.0.1:54321').host, '127.0.0.1:54321');
  assert.equal(assertLocalSupabaseUrl('http://LOCALHOST:54321/').hostname, 'localhost');
  for (const refused of [
    'https://abcdefghijklmnopqrst.supabase.co',
    'http://127.0.0.1.example.com:54321',
    'http://localhost.example.com',
    'http://localhost@example.com',
    'http://operator:secret@127.0.0.1:54321',
    'http://[::1]:54321',
    'http://0.0.0.0:54321',
    'ftp://localhost',
  ]) {
    assert.throws(() => assertLocalSupabaseUrl(refused), /LOCAL_SUPABASE_ONLY/, refused);
  }
  for (const missing of ['', undefined, null, 'not a url']) {
    assert.throws(() => assertLocalSupabaseUrl(missing), /LOCAL_SUPABASE_URL_REQUIRED/);
  }
});

test('no write and no foreign origin can leave the read-only transport', async () => {
  const sent = [];
  const readOnly = createReadOnlyFetch('http://127.0.0.1:54321', async (input, init) => {
    sent.push([String(input instanceof Request ? input.url : input), init.method ?? 'GET']);
    return new Response('[]');
  });
  await readOnly('http://127.0.0.1:54321/rest/v1/tests?select=id');
  await readOnly('http://127.0.0.1:54321/storage/v1/object/course-presentations/a.pdf', {
    method: 'get',
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assert.rejects(
      readOnly('http://127.0.0.1:54321/rest/v1/tests', { method }),
      new RegExp(`READ_ONLY_FETCH_METHOD_REFUSED:${method}`),
    );
  }
  await assert.rejects(
    readOnly(new Request('http://127.0.0.1:54321/rest/v1/rpc/publish', { method: 'POST' })),
    /READ_ONLY_FETCH_METHOD_REFUSED:POST/,
  );
  await assert.rejects(
    readOnly('https://abcdefghijklmnopqrst.supabase.co/rest/v1/tests'),
    /READ_ONLY_FETCH_FOREIGN_ORIGIN/,
  );
  await assert.rejects(
    readOnly('http://localhost:54321/rest/v1/tests'),
    /READ_ONLY_FETCH_FOREIGN_ORIGIN/,
  );
  assert.equal(sent.length, 2, 'only the two reads were sent');
});

test('answer-key fields are found by name at any depth and never echoed by value', () => {
  const secret = randomUUID();
  const paths = findAnswerKeyPaths(
    {
      variants: [
        { questions: [{ id: randomUUID(), text: 'Q', correctOptionId: secret }] },
        { answer_key: { correct_option_ids: [secret] } },
      ],
      options: [
        { text: 'A', isCorrect: true },
        { text: 'B', correct: false },
      ],
      legacy: { correctOptionIndex: 2, correctPositions: [1] },
      raw: `{"correctOptionId":"${secret}"}`,
    },
    'row',
  );
  assert.deepEqual(paths, [
    'row.variants[0].questions[0].correctOptionId',
    'row.variants[1].answer_key',
    'row.variants[1].answer_key.correct_option_ids',
    'row.options[0].isCorrect',
    'row.options[1].correct',
    'row.legacy.correctOptionIndex',
    'row.legacy.correctPositions',
    'row.raw (embedded text)',
  ]);
  assert.equal(paths.join('\n').includes(secret), false);
  assert.deepEqual(
    findAnswerKeyPaths({
      questions: [{ id: randomUUID(), text: 'Correct the fault first?', explanation: 'Correct.' }],
      translation_qa: { corrections: 0, assessmentImported: true },
      displayOrder: 1,
    }),
    [],
  );
});

test('Russian leftovers: a third Cyrillic in English or Chinese, a long identical string in Kazakh', () => {
  assert.equal(cyrillicShare('Сварщик'), 1);
  assert.equal(cyrillicShare('Welder 42 — 100%'), 0);
  assert.equal(cyrillicShare('12.1.004-91'), 0);
  const russianSentence = 'Работник обязан остановить работу и сообщить руководителю.';
  const russian = new Map([
    ['deck.slide1.title', russianSentence],
    ['deck.slide1.callout', 'СИЗ'],
  ]);
  assert.deepEqual(
    russianLeftovers(
      'en',
      new Map([
        ['db.title', 'Welder'],
        ['deck.slide1.title', russianSentence],
        ['deck.slide2.title', 'Comply with GOST (ГОСТ) 12.1.004 before any hot work starts'],
      ]),
      russian,
    ).map((line) => line.split(':')[0]),
    ['deck.slide1.title'],
  );
  assert.deepEqual(
    russianLeftovers(
      'zh',
      new Map([
        ['db.title', '焊工'],
        ['db.description', `焊工培训课程 ${russianSentence}`],
      ]),
      russian,
    ).map((line) => line.split(':')[0]),
    ['db.description'],
  );
  assert.deepEqual(
    russianLeftovers(
      'kk',
      new Map([
        ['deck.slide1.title', russianSentence],
        ['deck.slide1.callout', 'СИЗ'],
        [
          'deck.slide2.title',
          'Жұмысшы жұмысты тоқтатып, басшыға хабарлауға міндетті болып табылады.',
        ],
      ]),
      russian,
    ).map((line) => line.split(':')[0]),
    ['deck.slide1.title'],
  );
  assert.deepEqual(russianLeftovers('ru', russian, russian), []);
});

test('Russian and translated question rows compare by identity, order and wording', () => {
  const first = { id: randomUUID(), text: 'First?' };
  const second = { id: randomUUID(), text: 'Second?' };
  const option = { id: randomUUID(), text: 'Yes' };
  const russianShape = [
    { ...second, position: 2, options: [{ ...option, position: 1 }] },
    { ...first, position: 1, options: [{ ...option, position: 1 }] },
  ];
  const translatedShape = [
    { ...first, displayOrder: 1, options: [{ ...option, displayOrder: 1 }], explanation: 'x' },
    { ...second, displayOrder: 2, options: [{ ...option, displayOrder: 1 }], explanation: 'y' },
  ];
  assert.deepEqual(comparableQuestions(russianShape), comparableQuestions(translatedShape));
  assert.deepEqual(comparableQuestions(null), []);
});

test('a published bank equal to assessment.json passes; any drift in it is reported', () => {
  const authored = authoredBank();
  assert.deepEqual(questionProblems(authored, publishedBank(authored)), []);

  const reworded = publishedBank(authored);
  reworded.variantLocalizations[1].questions[4].options[2].text = 'Reworded in the database';
  assert.match(questionProblems(authored, reworded).join('\n'), /variant 2 question 5 option 3/);

  const silent = publishedBank(authored);
  silent.variantLocalizations[0].explanations[9] = '   ';
  assert.match(questionProblems(authored, silent).join('\n'), /variant 1: not 10 non-empty/);

  const short = publishedBank(authored);
  short.variantLocalizations[2].questions[0].options.pop();
  assert.match(
    questionProblems(authored, short).join('\n'),
    /variant 3: a question does not have 4/,
  );

  const untranslated = publishedBank(authored);
  untranslated.variantLocalizations.pop();
  assert.match(
    questionProblems(authored, untranslated).join('\n'),
    /variant 3: no en localization/,
  );

  const reshaped = publishedBank(authored);
  reshaped.variantLocalizations.push({
    ...reshaped.variantLocalizations[0],
    locale: 'kk',
    structure_hash: 'b'.repeat(64),
  });
  assert.match(
    questionProblems(authored, reshaped).join('\n'),
    /variant 1: structure_hash differs between languages/,
  );

  const otherPolicy = createCheck();
  checkQuestions({
    check: otherPolicy,
    revision: { ...REVISION_POLICY, pass_score: 6 },
    ...publishedBank(authored),
    assessment: { policy: POLICY, variants: authored },
    locale: 'en',
  });
  assert.match(otherPolicy.problems.join('\n'), /revision policy differs/);
});

test('text and SEO must equal the deck and never be the Russian fallback', () => {
  const description = 'Welding fundamentals, equipment and safe working practices for the course.';
  const deck = {
    title: 'Welder',
    description,
    seo: seo('Welder Training | Work Safety', description),
    sources: [{ id: 'law', title: 'Act', url: 'https://example.kz/act' }, { id: 'file-only' }],
  };
  const live = {
    title: deck.title,
    description,
    seo: { ...deck.seo },
    sources: [{ title: 'Act', url: 'https://example.kz/act' }],
  };
  const russianLive = {
    seo: seo('Сварщик | SafetyHub', 'Курс для сварщиков: подготовка соединений и оборудование.'),
  };
  const publicRecord = { locale: 'en', revisionId: 'r1', ...live };
  const problems = (overrides) => {
    const check = createCheck();
    checkTextAndSeo({
      check,
      live,
      publicRecord,
      deck,
      locale: 'en',
      russianLive,
      revisionId: 'r1',
      ...overrides,
    });
    return check.problems.join('\n');
  };
  assert.equal(problems({}), '');

  const fallback = seo('Материал SafetyHub', description);
  assert.match(
    problems({ live: { ...live, seo: fallback }, deck: { ...deck, seo: fallback } }),
    /seo\.title is the Russian default text/,
  );
  assert.match(
    problems({ live: { ...live, seo: russianLive.seo }, deck: { ...deck, seo: russianLive.seo } }),
    /seo\.ogDescription equals the Russian version/,
  );
  const tooShort = seo('Welder Training | Work Safety', 'Too short.');
  assert.match(
    problems({ live: { ...live, seo: tooShort }, deck: { ...deck, seo: tooShort } }),
    /fails contentSeoSchema/,
  );
  assert.match(problems({ live: { ...live, title: 'Welders' } }), /title "Welders" differs/);
  assert.match(problems({ live: { ...live, sources: [] } }), /sources differ from the deck/);
  assert.match(
    problems({ publicRecord: { ...publicRecord, revisionId: 'older' } }),
    /anonymous read\) does not return the deck text and SEO/,
  );
});

test('nothing unpublished may be pending; only Russian may prove it by fields', () => {
  const localization = {
    title: 'Сварщик',
    description: 'Описание',
    content: { modules: [] },
    seo: { title: 'Сварщик | SafetyHub' },
    sources: [],
  };
  const input = (locale, overrides = {}) => ({
    check: createCheck(),
    test: {
      id: 't1',
      slug: 'svarshchik',
      status: 'published',
      current_revision_id: 'r1',
      content_hash: HASH,
    },
    draft: { content_hash: HASH },
    revision: { id: 'r1', test_id: 't1', slug: 'svarshchik', content_hash: HASH },
    live: { ...localization, content_hash: HASH, published_at: '2026-09-19T11:36:47.677Z' },
    draftLocalization: {
      ...localization,
      content_hash: HASH,
      reviewed_content_hash: HASH,
      status: 'complete',
    },
    mappings: { live: { presentation_id: 'p1' }, draft: { presentation_id: 'p1' } },
    listed: { slug: 'svarshchik', title: 'Сварщик' },
    deck: { title: 'Сварщик' },
    locale,
    ...overrides,
  });
  const run = (locale, overrides) => {
    const prepared = input(locale, overrides);
    checkPublication(prepared);
    return prepared.check;
  };
  assert.deepEqual(run('kk').problems, []);

  // The live Russian row carries the course hash, a saved Russian draft the localized one.
  const otherHash = { content_hash: 'c'.repeat(64), reviewed_content_hash: 'c'.repeat(64) };
  const russian = run('ru', {
    draftLocalization: { ...localization, ...otherHash, status: 'complete' },
  });
  assert.deepEqual(russian.problems, []);
  assert.equal(russian.facts.draftEqualsLive, 'fields (hash domains differ)');
  assert.match(
    run('kk', {
      draftLocalization: { ...localization, ...otherHash, status: 'complete' },
    }).problems.join('\n'),
    /unpublished changes/,
  );
  assert.match(
    run('ru', {
      draftLocalization: { ...localization, ...otherHash, status: 'complete', title: 'Сварщик 2' },
    }).problems.join('\n'),
    /unpublished changes/,
  );
  assert.match(
    run('kk', { draft: { content_hash: 'd'.repeat(64) } }).problems.join('\n'),
    /unpublished course changes/,
  );
  assert.match(
    run('kk', {
      draftLocalization: {
        ...localization,
        content_hash: HASH,
        reviewed_content_hash: null,
        status: 'draft',
      },
    }).problems.join('\n'),
    /draft status is "draft"/,
  );
  assert.match(
    run('kk', {
      mappings: { live: { presentation_id: 'p1' }, draft: { presentation_id: 'p2' } },
    }).problems.join('\n'),
    /presentation mappings differ/,
  );
  assert.match(run('kk', { listed: undefined }).problems.join('\n'), /catalogue does not list/);
  assert.match(
    run('kk', {
      test: {
        id: 't1',
        slug: 'svarshchik',
        status: 'draft',
        current_revision_id: null,
        content_hash: HASH,
      },
    }).problems.join('\n'),
    /tests\.status is "draft"/,
  );
});
