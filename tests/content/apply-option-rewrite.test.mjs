import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  LOCALES,
  buildPayloads,
  diffModels,
  draftBlockers,
  guardTarget,
  inspectDraft,
  parseArguments,
  planRewrite,
  readModel,
  validateRewrite,
  verifyPublished,
} from '../../scripts/content/apply-option-rewrite.mjs';

const WORD = { ru: 'Ответ', kk: 'Жауап', en: 'Answer', zh: '答案' };
const STEM = { ru: 'Вопрос', kk: 'Сұрақ', en: 'Question', zh: '问题' };

// A live revision as the service key reads it: three variants of ten questions of four
// options, the second option correct, in four languages, with a clean draft.
function fixture() {
  const revisionId = randomUUID();
  const presentations = Object.fromEntries(LOCALES.map((l) => [l, randomUUID()]));
  const variants = [];
  const variantLocalizations = [];
  const bank = [];
  const base = { slug: 'demo', revisionId, version: 3, variants: [] };
  for (let v = 1; v <= 3; v += 1) {
    const rowId = randomUUID();
    const stableId = randomUUID();
    const questions = Array.from({ length: 10 }, (_, q) => ({
      id: randomUUID(),
      text: Object.fromEntries(LOCALES.map((l) => [l, `${STEM[l]} ${v}.${q + 1}?`])),
      options: Array.from({ length: 4 }, (_, o) => ({
        id: randomUUID(),
        text: Object.fromEntries(LOCALES.map((l) => [l, `${WORD[l]} ${v}.${q + 1}.${o + 1}`])),
      })),
    }));
    for (const q of questions) q.correctOptionId = q.options[1].id;
    bank.push({
      id: stableId,
      variantNumber: v,
      questions: questions.map((q, i) => ({
        id: q.id,
        text: q.text.ru,
        displayOrder: i + 1,
        options: q.options.map((o, j) => ({ id: o.id, text: o.text.ru, displayOrder: j + 1 })),
        correctOptionId: q.correctOptionId,
        explanation: '',
      })),
    });
    variants.push({
      id: rowId,
      stable_id: stableId,
      variant_number: v,
      questions: questions.map((q, i) => ({
        id: q.id,
        text: q.text.ru,
        position: i + 1,
        options: q.options.map((o, j) => ({ id: o.id, text: o.text.ru, position: j + 1 })),
      })),
    });
    for (const locale of LOCALES)
      variantLocalizations.push({
        variant_id: rowId,
        locale,
        questions: questions.map((q) => ({
          id: q.id,
          text: q.text[locale],
          options: q.options.map((o) => ({ id: o.id, text: o.text[locale] })),
        })),
        explanations: questions.map(() => ''),
      });
    base.variants.push({
      variantId: rowId,
      variantNumber: v,
      questions: questions.map((q) => ({
        questionId: q.id,
        text: { ...q.text },
        correct: { id: q.correctOptionId, ...q.options[1].text },
        distractors: q.options
          .filter((o) => o.id !== q.correctOptionId)
          .map((o) => ({ id: o.id, ...o.text })),
      })),
    });
  }
  const course = {
    slug: 'demo',
    title: 'Демо курс',
    description: 'Описание',
    icon: 'factory',
    display_order: 1,
    presentation_id: presentations.ru,
    duration_minutes: 15,
    pass_score: 7,
    attempts_per_calendar_day: 8,
    attempt_reset_timezone: 'Asia/Oral',
    seo: { title: 'Демо' },
    jurisdiction: 'Республика Казахстан',
    effective_date: '2026-09-01',
    sources: [],
  };
  const meta = (l) => ({
    title: `Demo ${l}`,
    description: '',
    content: { modules: [] },
    seo: { title: l },
    sources: [],
  });
  const liveWording = (l) => buildPayloads(readModel({ ...rowsOf() }).model.variants).localized[l];
  function rowsOf() {
    return {
      test: {
        id: 'course',
        slug: 'demo',
        status: 'published',
        current_revision_id: revisionId,
        content_version: 3,
        content_hash: 'hash-live',
        draft_content: { questions: [], questionVariants: bank },
      },
      revision: { id: revisionId, version: 3, content_hash: 'hash-live', ...course },
      variants,
      localizations: LOCALES.map((l) => ({ locale: l, content_hash: `loc-${l}`, ...meta(l) })),
      variantLocalizations,
      mappings: LOCALES.map((l) => ({ locale: l, presentation_id: presentations[l] })),
      draft: {
        test_id: 'course',
        draft_version: 2,
        content_hash: 'hash-live',
        question_variants: bank,
        ...course,
      },
      draftLocalizations: [],
      draftMappings: LOCALES.map((l) => ({ locale: l, presentation_id: presentations[l] })),
    };
  }
  const rows = rowsOf();
  rows.draftLocalizations = LOCALES.map((l) => ({
    locale: l,
    status: 'complete',
    draft_version: 2,
    content_hash: `loc-${l}`,
    reviewed_content_hash: `loc-${l}`,
    translation_qa: { status: 'passed', assessmentImported: true },
    question_variants: l === 'ru' ? [] : liveWording(l),
    ...meta(l),
  }));
  return { rows, base };
}

// Rewrites the three wrong options of v1 q1 and fixes the kk stem and zh correct option.
function rewriteFor(base) {
  const question = base.variants[0].questions[0];
  return {
    slug: 'demo',
    variants: [
      {
        variantId: base.variants[0].variantId,
        questions: [
          {
            questionId: question.questionId,
            distractors: question.distractors.map((d, i) => ({
              id: d.id,
              ru: `Новый неверный ${i}`,
              kk: `Жаңа қате ${i}`,
              en: `New wrong ${i}`,
              zh: `新错误 ${i}`,
            })),
            text: { kk: 'Түзетілген сұрақ?' },
            correct: { zh: '更正的答案' },
          },
        ],
      },
    ],
  };
}

test('readModel reads the live revision in four locales and flags a bank that disagrees', () => {
  const { rows } = fixture();
  const { model, problems } = readModel(rows);
  assert.deepEqual(problems, []);
  assert.equal(model.variants.length, 3);
  const question = model.variants[0].questions[0];
  assert.deepEqual(Object.keys(question.text), LOCALES);
  assert.equal(question.correctOptionId, question.options[1].id);

  rows.test.draft_content.questionVariants[0].questions[0].options[0].text = 'Иначе';
  assert.match(readModel(rows).problems.join(), /BANK_REVISION_MISMATCH:v1:q1/u);
});

test('a reviewed rewrite changes the wrong options and the named translations only', () => {
  const { rows, base } = fixture();
  const plan = planRewrite({ rows, rewrite: rewriteFor(base), base });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.summary.ru, {
    wrongOptions: 3,
    correctOptions: 0,
    questionTexts: 0,
    questions: 1,
  });
  assert.deepEqual(plan.summary.kk, {
    wrongOptions: 3,
    correctOptions: 0,
    questionTexts: 1,
    questions: 1,
  });
  assert.deepEqual(plan.summary.zh, {
    wrongOptions: 3,
    correctOptions: 1,
    questionTexts: 0,
    questions: 1,
  });

  const before = plan.model.variants[0].questions[0];
  const bankQuestion = plan.payloads.bank[0].questions[0];
  assert.equal(bankQuestion.text, before.text.ru);
  assert.equal(bankQuestion.correctOptionId, before.correctOptionId);
  assert.equal(bankQuestion.options[1].text, before.options[1].text.ru);
  assert.equal(bankQuestion.options[0].text, 'Новый неверный 0');
  assert.deepEqual(
    bankQuestion.options.map((o) => o.id),
    before.options.map((o) => o.id),
  );
  const kk = plan.payloads.localized.kk[0].questions[0];
  assert.equal(kk.text, 'Түзетілген сұрақ?');
  assert.equal(plan.payloads.localized.zh[0].questions[0].options[1].text, '更正的答案');
  assert.equal(plan.payloads.localized.en[0].questions[0].text, before.text.en);
  // Nothing else in the course moves.
  assert.equal(plan.edits.length, 3 * 4 + 1 + 1);
});

test('refuses to rewrite the correct option or an id the live revision does not have', () => {
  const { rows, base } = fixture();
  const rewrite = rewriteFor(base);
  const question = rewrite.variants[0].questions[0];
  question.distractors[0].id = base.variants[0].questions[0].correct.id;
  question.distractors[1].id = randomUUID();
  const plan = planRewrite({ rows, rewrite, base });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join(), /CORRECT_OPTION_REWRITTEN/u);
  assert.match(plan.errors.join(), /OPTION_NOT_FOUND/u);
  assert.equal(plan.checks.find((c) => c.check.startsWith('no rewritten option')).ok, false);

  const unknown = rewriteFor(base);
  unknown.variants[0].questions[0].questionId = randomUUID();
  assert.match(planRewrite({ rows, rewrite: unknown, base }).errors.join(), /QUESTION_NOT_FOUND/u);
});

test('refuses when the Russian wording or the answer key moved since the export', () => {
  const { rows, base } = fixture();
  base.variants[0].questions[0].text.ru = 'Другой вопрос?';
  base.variants[0].questions[0].correct.ru = 'Другой ответ';
  base.variants[0].questions[0].correct.id = randomUUID();
  const errors = planRewrite({ rows, rewrite: rewriteFor(base), base }).errors.join();
  assert.match(errors, /RU_STEM_CHANGED/u);
  assert.match(errors, /RU_CORRECT_CHANGED/u);
  assert.match(errors, /ANSWER_KEY_CHANGED/u);
});

test('Russian overrides are refused; a translation fixed on the target is not overwritten', () => {
  const { rows, base } = fixture();
  const rewrite = rewriteFor(base);
  rewrite.variants[0].questions[0].text.ru = 'Нельзя';
  assert.match(planRewrite({ rows, rewrite, base }).errors.join(), /RU_OVERRIDE_FORBIDDEN/u);

  const moved = fixture();
  moved.rows.variantLocalizations.find((l) => l.locale === 'kk').questions[0].text =
    'Басқа біреу түзетті?';
  const refused = planRewrite({
    rows: moved.rows,
    rewrite: rewriteFor(moved.base),
    base: moved.base,
  });
  assert.match(refused.errors.join(), /LOCALIZED_TEXT_CHANGED:.*:text:kk/u);

  const applied = fixture();
  applied.rows.variantLocalizations.find((l) => l.locale === 'kk').questions[0].text =
    'Түзетілген сұрақ?';
  const again = planRewrite({
    rows: applied.rows,
    rewrite: rewriteFor(applied.base),
    base: applied.base,
  });
  assert.equal(again.ok, true, JSON.stringify(again.errors));
  assert.equal(again.summary.kk.questionTexts, 0);
});

test('invalid texts and repeated answers are refused', () => {
  const { rows, base } = fixture();
  const rewrite = rewriteFor(base);
  const question = rewrite.variants[0].questions[0];
  question.distractors[0].en = '  ';
  question.distractors[1].kk = 'Бір\nекі';
  question.distractors[2].ru = base.variants[0].questions[0].correct.ru;
  const errors = planRewrite({ rows, rewrite, base }).errors.join();
  assert.match(errors, /TEXT_EMPTY:.*:en/u);
  assert.match(errors, /TEXT_CONTROL_CHARACTER:.*:kk/u);
  assert.match(errors, /OPTION_TEXTS_NOT_DISTINCT:.*:ru/u);
});

test('a variant exported from an earlier revision is found by its number', () => {
  const { rows, base } = fixture();
  for (const variant of rows.variants) {
    const fresh = randomUUID();
    for (const loc of rows.variantLocalizations)
      if (loc.variant_id === variant.id) loc.variant_id = fresh;
    variant.id = fresh;
  }
  const plan = planRewrite({ rows, rewrite: rewriteFor(base), base });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.match(plan.warnings.join(), /VARIANT_RESOLVED_BY_NUMBER/u);
});

test('the draft is continued only when it holds this rewrite; pending metadata needs a decision', () => {
  const { rows, base } = fixture();
  const rewrite = rewriteFor(base);
  const plan = planRewrite({ rows, rewrite, base });
  assert.deepEqual(plan.inspection.course, 'clean');

  const interrupted = structuredClone(rows);
  interrupted.draft.content_hash = 'hash-draft';
  interrupted.draft.question_variants = plan.payloads.bank;
  interrupted.draftLocalizations.find((l) => l.locale === 'kk').question_variants =
    plan.payloads.localized.kk;
  let inspection = inspectDraft(interrupted, plan.model, plan.payloads);
  assert.equal(inspection.course, 'in-progress');
  assert.equal(inspection.locales.kk.wording, 'in-progress');
  assert.deepEqual(draftBlockers(inspection, null), []);

  const foreign = structuredClone(rows);
  foreign.draft.content_hash = 'hash-other';
  foreign.draft.title = 'Чужая правка';
  foreign.draftLocalizations.find((l) => l.locale === 'en').question_variants[0].questions[0].text =
    'Edited';
  foreign.draftLocalizations.find((l) => l.locale === 'zh').seo = { title: '新的' };
  inspection = inspectDraft(foreign, plan.model, plan.payloads);
  const blockers = draftBlockers(inspection, null).join();
  assert.match(blockers, /DRAFT_HAS_UNPUBLISHED_COURSE_CHANGES/u);
  assert.match(blockers, /DRAFT_HAS_UNPUBLISHED_WORDING:en/u);
  assert.match(blockers, /PENDING_DRAFT_DECISION_REQUIRED:zh:seo/u);
  assert.doesNotMatch(draftBlockers(inspection, 'publish').join(), /PENDING_DRAFT/u);
});

test('the re-read revision must keep ids and answers and carry exactly the intended texts', () => {
  const { rows, base } = fixture();
  const plan = planRewrite({ rows, rewrite: rewriteFor(base), base });
  const localizations = Object.fromEntries(
    ['kk', 'en', 'zh'].map((l) => [
      l,
      { ...plan.model.localizations[l], presentationId: plan.model.presentations[l] },
    ]),
  );
  const publish = (mutate) => {
    const after = structuredClone(rows);
    const revisionId = randomUUID();
    after.test.current_revision_id = revisionId;
    after.revision.id = revisionId;
    after.revision.version = 4;
    after.test.content_hash = after.revision.content_hash = after.draft.content_hash = 'hash-next';
    after.test.draft_content.questionVariants = plan.payloads.bank;
    for (const variant of after.variants) {
      const next = plan.next.find((v) => v.stableId === variant.stable_id);
      variant.questions = next.questions.map((q) => ({
        id: q.id,
        text: q.text.ru,
        options: q.options.map((o) => ({ id: o.id, text: o.text.ru })),
      }));
      for (const loc of after.variantLocalizations.filter((l) => l.variant_id === variant.id))
        loc.questions = next.questions.map((q) => ({
          id: q.id,
          text: q.text[loc.locale],
          options: q.options.map((o) => ({ id: o.id, text: o.text[loc.locale] })),
        }));
    }
    mutate?.(after);
    return verifyPublished({
      before: plan.model,
      next: plan.next,
      localizations,
      afterRows: after,
    });
  };
  assert.deepEqual(publish().failures, []);
  const swapped = publish((after) => {
    const q = after.test.draft_content.questionVariants[0].questions[0];
    q.correctOptionId = q.options[0].id;
  });
  assert.match(swapped.failures.join(), /ANSWER_KEY_CHANGED:v1:q1/u);
  const lost = publish((after) => {
    after.variantLocalizations.find((l) => l.locale === 'kk').questions[0].text = 'ескі';
  });
  assert.match(lost.failures.join(), /STEM_NOT_AS_INTENDED:v1:q1:kk/u);
});

test('diffModels reports nothing for a rewrite that is already live', () => {
  const { rows } = fixture();
  const { model } = readModel(rows);
  assert.deepEqual(diffModels(model.variants, structuredClone(model.variants)).edits, []);
  const { rows: rowsAgain, base } = fixture();
  const result = validateRewrite({
    rewrite: { slug: 'demo', variants: [] },
    base,
    model: readModel(rowsAgain).model,
  });
  assert.deepEqual(result.errors, []);
});

test('production needs the linked host and, to apply, the reviewed file hash', () => {
  const hash = 'a'.repeat(64);
  const production = 'https://podkjjguhhdiecrgznoa.supabase.co';
  assert.equal(
    guardTarget({
      target: 'local',
      mode: 'apply',
      url: 'http://127.0.0.1:54321',
      secret: 's',
      fileSha256: hash,
    }).local,
    true,
  );
  assert.equal(
    guardTarget({
      target: 'production',
      mode: 'plan',
      url: production,
      secret: 's',
      fileSha256: hash,
    }).local,
    false,
  );
  assert.throws(
    () =>
      guardTarget({
        target: 'production',
        mode: 'apply',
        url: production,
        secret: 's',
        fileSha256: hash,
      }),
    /REVIEWED_FILE_HASH_REQUIRED/u,
  );
  assert.throws(
    () =>
      guardTarget({
        target: 'production',
        mode: 'apply',
        url: production,
        secret: 's',
        confirmHash: 'b'.repeat(64),
        fileSha256: hash,
      }),
    /CONFIRM_HASH_MISMATCH/u,
  );
  assert.equal(
    guardTarget({
      target: 'production',
      mode: 'apply',
      url: production,
      secret: 's',
      confirmHash: hash,
      fileSha256: hash,
    }).host,
    'podkjjguhhdiecrgznoa.supabase.co',
  );
  assert.throws(
    () =>
      guardTarget({
        target: 'production',
        mode: 'plan',
        url: 'https://other.supabase.co',
        secret: 's',
        fileSha256: hash,
      }),
    /PRODUCTION_TARGET_MISMATCH/u,
  );
  assert.throws(
    () =>
      guardTarget({
        target: 'local',
        mode: 'plan',
        url: production,
        secret: 's',
        fileSha256: hash,
      }),
    /TARGET_MISMATCH/u,
  );

  const parsed = parseArguments(['--rewrite=rewrite/biot.json', '--target=local', '--plan']);
  assert.equal(parsed.mode, 'plan');
  assert.match(parsed.base, /input[\\/]biot\.json$/u);
  assert.throws(
    () => parseArguments(['--rewrite=x.json', '--target=local', '--plan', '--apply']),
    /CHOOSE_PLAN_OR_APPLY/u,
  );
  assert.throws(
    () => parseArguments(['--rewrite=x.json', '--target=staging', '--plan']),
    /TARGET_REQUIRED/u,
  );
  assert.throws(
    () => parseArguments(['--rewrite=x.json', '--target=local', '--plan', '--force']),
    /UNKNOWN_ARGUMENT/u,
  );
});
