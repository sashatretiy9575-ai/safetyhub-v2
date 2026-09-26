// Publish reviewed wording for the wrong options of one course's test — and fixed kk/en/zh
// question texts or correct options — as a new immutable four-locale revision.
//
// Usage:
//   node --env-file=.env.local scripts/content/apply-option-rewrite.mjs \
//     --rewrite=<slug>.json --target=local|production (--plan|--apply) \
//     [--base=<export the rewrite was written against>] [--confirm-hash=<sha256 of --rewrite>] \
//     [--pending-draft=publish|discard] [--operator-email=<admin e-mail>] [--diff]
//
// The rewrite file: {"slug","variants":[{"variantId","questions":[{"questionId",
//   "distractors":[{"id","ru","kk","en","zh"}], "text"?:{"kk"?,"en"?,"zh"?},
//   "correct"?:{"kk"?,"en"?,"zh"?}}]}]}. --base defaults to ../input/<same name> beside it: the
// export of the live revision the rewrite was written against (variantId, variantNumber, and
// per question text/correct/distractors in four languages).
//
// What never changes: Russian question texts, Russian correct options, every identifier, the
// order of questions and options, and which option is correct. The tool refuses when the
// target's Russian wording or answer key differs from the base (the target moved on since the
// export), when an id does not resolve, when a rewritten option is the correct one, or when an
// overridden translation was changed on the target in the meantime.
//
// How it writes: the same RPCs as the admin editor and the batch publisher, so the database
// computes every content hash (the SEO is part of it): save_course_draft_v3 for the Russian
// bank rebuilt from the LIVE revision, import_course_assessment_localization and
// save_course_localization_draft for kk/en/zh, then publish_course_revision_v4. The run is
// resumable: a draft already carrying exactly this rewrite is continued, a draft with anyone
// else's unpublished work is refused. Unpublished kk/en/zh metadata edits (title, description,
// SEO, sources, presentation) are a decision: --pending-draft=publish carries them into the new
// revision, --pending-draft=discard resets them to the live revision.
//
// Safety: --plan only reads (service key). Production must be the linked project
// (podkjjguhhdiecrgznoa.supabase.co) and --apply there needs --confirm-hash equal to the
// sha256 of the rewrite file that --plan prints. After publishing, the new revision is re-read
// and checked: same ids and answer key, the intended texts, four published locales. On the
// local stand the private answer-key table is also compared through DATABASE_URL.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ContentFixError as RewriteError,
  LOCALES,
  TRANSLATED,
  clean,
  connectTarget,
  isObject,
  operatorRepository,
  parseCommonArguments,
  runCli,
  sameJson,
  sha256,
  textProblem,
} from './content-fix-common.mjs';

export { LOCALES, TRANSLATED, sameJson, sha256 };
export { guardTarget } from './content-fix-common.mjs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// The limits private.course_question_variants_valid and the import RPC enforce.
const RU_OPTION_MAX = 1000;
const TEXT_MAX = 2000;
const META_FIELDS = ['title', 'description', 'content', 'seo', 'sources'];
const COURSE_FIELDS = [
  'slug',
  'title',
  'description',
  'icon',
  'display_order',
  'presentation_id',
  'duration_minutes',
  'pass_score',
  'attempts_per_calendar_day',
  'attempt_reset_timezone',
  'seo',
  'jurisdiction',
  'effective_date',
  'sources',
];
// Each refusal code belongs to one of the checks --plan reports.
const CHECKS = [
  [
    'live revision is self-consistent (bank = revision = locales)',
    /^(LIVE_|BANK_|LOCALE_|LOCALIZED_STRUCTURE|RU_EXPLANATION)/u,
  ],
  [
    'every variant, question and option id resolves',
    /^(VARIANT_(NOT|NUMBER|QUESTIONS)|QUESTION_NOT_FOUND|OPTION_NOT_FOUND|ID_DUPLICATE)/u,
  ],
  ['no rewritten option is the correct one', /^CORRECT_OPTION_REWRITTEN/u],
  ['answer key unchanged since the export', /^ANSWER_KEY_CHANGED/u],
  [
    'Russian stems and correct options unchanged',
    /^(RU_STEM_CHANGED|RU_CORRECT_CHANGED|RU_OVERRIDE_FORBIDDEN)/u,
  ],
  ['overridden translations unchanged since the export', /^LOCALIZED_TEXT_CHANGED/u],
  ['texts valid and options distinct', /^(TEXT_|OPTION_TEXTS_NOT_DISTINCT|STEM_DUPLICATE)/u],
];

/**
 * Builds the four-locale model of the live revision from rows readable with the service key.
 * `tests.draft_content` is written in the same transaction as the private answer keys when a
 * revision is published, and the revision itself carries the public texts; both must agree.
 */
export function readModel(rows) {
  const problems = [];
  const { test, revision } = rows;
  if (test.status !== 'published' || !test.current_revision_id)
    problems.push('LIVE_COURSE_NOT_PUBLISHED');
  if (revision?.id !== test.current_revision_id || test.content_hash !== revision?.content_hash)
    problems.push('LIVE_REVISION_POINTER_MISMATCH');
  const bank = test.draft_content?.questionVariants;
  if (!Array.isArray(bank) || bank.length !== 3) problems.push('BANK_MISSING');
  const model = {
    courseId: test.id,
    slug: test.slug,
    revisionId: revision?.id ?? null,
    version: revision?.version ?? null,
    contentHash: revision?.content_hash ?? null,
    revision,
    localizations: {},
    presentations: {},
    variants: [],
  };
  for (const locale of LOCALES) {
    const row = rows.localizations.find((item) => item.locale === locale);
    if (!row) problems.push(`LOCALE_NOT_PUBLISHED:${locale}`);
    model.localizations[locale] = Object.fromEntries(META_FIELDS.map((key) => [key, row?.[key]]));
    model.presentations[locale] =
      rows.mappings.find((item) => item.locale === locale)?.presentation_id ?? null;
    if (!model.presentations[locale]) problems.push(`LOCALE_PRESENTATION_MISSING:${locale}`);
  }
  const variants = [...rows.variants].sort((a, b) => a.variant_number - b.variant_number);
  if (variants.length !== 3) problems.push('LIVE_VARIANTS_INCOMPLETE');
  for (const variant of variants) {
    const where = `v${variant.variant_number}`;
    const banked = (Array.isArray(bank) ? bank : []).find((item) => item.id === variant.stable_id);
    if (!banked || Number(banked.variantNumber) !== variant.variant_number) {
      problems.push(`BANK_VARIANT_MISMATCH:${where}`);
      continue;
    }
    const localized = {};
    for (const locale of LOCALES) {
      localized[locale] = rows.variantLocalizations.find(
        (item) => item.variant_id === variant.id && item.locale === locale,
      );
      if (!localized[locale]) problems.push(`LOCALE_VARIANT_MISSING:${where}:${locale}`);
    }
    if (LOCALES.some((locale) => !localized[locale])) continue;
    const questions = variant.questions.map((question, qi) => {
      const bq = banked.questions?.[qi];
      if (
        bq?.id !== question.id ||
        clean(bq.text) !== clean(question.text) ||
        bq.options?.length !== question.options.length ||
        question.options.some(
          (option, oi) =>
            bq.options[oi].id !== option.id || clean(bq.options[oi].text) !== clean(option.text),
        ) ||
        !question.options.some((option) => option.id === bq.correctOptionId)
      )
        problems.push(`BANK_REVISION_MISMATCH:${where}:q${qi + 1}`);
      const text = {};
      const explanation = {};
      const options = question.options.map((option) => ({ id: option.id, text: {} }));
      for (const locale of LOCALES) {
        const lq = localized[locale].questions[qi];
        if (
          lq?.id !== question.id ||
          lq.options?.length !== question.options.length ||
          question.options.some((option, oi) => lq.options[oi].id !== option.id)
        ) {
          problems.push(`LOCALIZED_STRUCTURE_MISMATCH:${where}:q${qi + 1}:${locale}`);
          continue;
        }
        text[locale] = lq.text;
        explanation[locale] = localized[locale].explanations?.[qi] ?? '';
        lq.options.forEach((option, oi) => {
          options[oi].text[locale] = option.text;
        });
      }
      // The Russian locale row holds the explanations copied from the private answer key.
      if ((bq?.explanation ?? '') !== explanation.ru)
        problems.push(`RU_EXPLANATION_MISMATCH:${where}:q${qi + 1}`);
      return {
        id: question.id,
        correctOptionId: bq?.correctOptionId ?? null,
        text,
        explanation,
        options,
      };
    });
    model.variants.push({
      rowId: variant.id,
      stableId: variant.stable_id,
      variantNumber: variant.variant_number,
      questions,
    });
  }
  return { model, problems };
}

/** Validates the rewrite against its base export and the live model; returns the next texts. */
export function validateRewrite({ rewrite, base, model }) {
  const errors = [];
  const warnings = [];
  const touched = [];
  const fail = (code, where) => errors.push(where ? `${code}:${where}` : code);
  if (!isObject(rewrite) || !Array.isArray(rewrite.variants)) {
    fail('REWRITE_SHAPE_INVALID');
    return { errors, warnings, next: null, touched };
  }
  for (const key of Object.keys(rewrite))
    if (!['slug', 'variants'].includes(key)) fail('REWRITE_UNKNOWN_KEY', key);
  if (rewrite.slug !== model.slug) fail('REWRITE_SLUG_MISMATCH', `${rewrite.slug}`);
  if (!isObject(base) || base.slug !== model.slug || !Array.isArray(base.variants))
    fail('BASE_INVALID', 'the export must name the same course');
  const next = structuredClone(model.variants);
  const seen = new Set();
  const once = (id, where) => {
    if (seen.has(id)) fail('ID_DUPLICATE', where);
    seen.add(id);
  };
  for (const rv of rewrite.variants) {
    if (!UUID.test(rv?.variantId ?? '') || !Array.isArray(rv.questions)) {
      fail('VARIANT_SHAPE_INVALID', rv?.variantId);
      continue;
    }
    once(rv.variantId, rv.variantId);
    const bv = base?.variants?.find?.((item) => item.variantId === rv.variantId);
    if (!bv) {
      fail('VARIANT_NOT_IN_BASE', rv.variantId);
      continue;
    }
    // The export names the live revision's variant row, which a later revision renumbers;
    // the stable id or, failing both, the variant number of the export locate it.
    let vi = model.variants.findIndex(
      (item) => item.rowId === rv.variantId || item.stableId === rv.variantId,
    );
    if (vi < 0) {
      vi = model.variants.findIndex((item) => item.variantNumber === bv.variantNumber);
      if (vi >= 0)
        warnings.push(
          `VARIANT_RESOLVED_BY_NUMBER:${rv.variantId}:v${bv.variantNumber} (export of revision ${base.revisionId ?? '?'})`,
        );
    } else if (model.variants[vi].variantNumber !== bv.variantNumber) {
      fail('VARIANT_NUMBER_CHANGED', rv.variantId);
      continue;
    }
    if (vi < 0) {
      fail('VARIANT_NOT_FOUND', rv.variantId);
      continue;
    }
    const cv = model.variants[vi];
    if (
      JSON.stringify(bv.questions?.map((q) => q.questionId)) !==
      JSON.stringify(cv.questions.map((q) => q.id))
    ) {
      fail('VARIANT_QUESTIONS_CHANGED', `v${cv.variantNumber}`);
      continue;
    }
    for (const rq of rv.questions) {
      const qi = cv.questions.findIndex((item) => item.id === rq?.questionId);
      const where = `v${cv.variantNumber}:${rq?.questionId}`;
      if (qi < 0) {
        fail('QUESTION_NOT_FOUND', where);
        continue;
      }
      once(rq.questionId, where);
      for (const key of Object.keys(rq))
        if (!['questionId', 'distractors', 'text', 'correct'].includes(key))
          fail('QUESTION_UNKNOWN_KEY', `${where}:${key}`);
      const cq = cv.questions[qi];
      const nq = next[vi].questions[qi];
      const bq = bv.questions[qi];
      const correct = cq.options.find((option) => option.id === cq.correctOptionId);
      if (clean(bq.text?.ru) !== clean(cq.text.ru)) fail('RU_STEM_CHANGED', where);
      if (bq.correct?.id !== cq.correctOptionId) fail('ANSWER_KEY_CHANGED', where);
      if (clean(bq.correct?.ru) !== clean(correct?.text.ru)) fail('RU_CORRECT_CHANGED', where);
      touched.push({ vi, qi });
      if (!Array.isArray(rq.distractors) || rq.distractors.length === 0)
        fail('QUESTION_DISTRACTORS_MISSING', where);
      for (const distractor of rq.distractors ?? []) {
        const oi = cq.options.findIndex((option) => option.id === distractor?.id);
        const at = `${where}:${distractor?.id}`;
        if (oi < 0) {
          fail('OPTION_NOT_FOUND', at);
          continue;
        }
        once(distractor.id, at);
        if (distractor.id === cq.correctOptionId) {
          fail('CORRECT_OPTION_REWRITTEN', at);
          continue;
        }
        for (const key of Object.keys(distractor))
          if (!['id', ...LOCALES].includes(key)) fail('TEXT_UNKNOWN_LOCALE', `${at}:${key}`);
        for (const locale of LOCALES) {
          const problem = textProblem(
            distractor[locale],
            locale === 'ru' ? RU_OPTION_MAX : TEXT_MAX,
          );
          if (problem) fail(problem, `${at}:${locale}`);
          else if (clean(distractor[locale]) !== clean(cq.options[oi].text[locale]))
            nq.options[oi].text[locale] = clean(distractor[locale]);
        }
      }
      for (const field of ['text', 'correct']) {
        if (rq[field] === undefined) continue;
        if (!isObject(rq[field])) {
          fail('TEXT_OVERRIDE_INVALID', `${where}:${field}`);
          continue;
        }
        const ci = cq.options.indexOf(correct);
        for (const [locale, value] of Object.entries(rq[field])) {
          const at = `${where}:${field}:${locale}`;
          if (locale === 'ru') {
            fail('RU_OVERRIDE_FORBIDDEN', at);
            continue;
          }
          if (!TRANSLATED.includes(locale)) {
            fail('TEXT_UNKNOWN_LOCALE', at);
            continue;
          }
          const problem = textProblem(value, TEXT_MAX);
          if (problem) {
            fail(problem, at);
            continue;
          }
          const live = field === 'text' ? cq.text[locale] : correct.text[locale];
          const exported = field === 'text' ? bq.text?.[locale] : bq.correct?.[locale];
          // A translation somebody fixed on the target since the export is not overwritten.
          if (clean(live) !== clean(exported) && clean(live) !== clean(value)) {
            fail('LOCALIZED_TEXT_CHANGED', at);
            continue;
          }
          if (clean(value) === clean(live)) continue;
          if (field === 'text') nq.text[locale] = clean(value);
          else nq.options[ci].text[locale] = clean(value);
        }
      }
      for (const [oi, option] of cq.options.entries()) {
        const exported = [...(bq.distractors ?? []), bq.correct].find(
          (item) => item?.id === option.id,
        );
        if (exported && LOCALES.some((l) => clean(exported[l]) !== clean(option.text[l])))
          warnings.push(`OPTION_CHANGED_SINCE_EXPORT:${where}:o${oi + 1}`);
      }
    }
  }
  // Four distinct answers per touched question, and a rewritten stem does not repeat another.
  for (const { vi, qi } of touched) {
    const question = next[vi].questions[qi];
    const where = `v${next[vi].variantNumber}:${question.id}`;
    for (const locale of LOCALES) {
      const texts = question.options.map((option) => clean(option.text[locale]).toLowerCase());
      if (new Set(texts).size !== texts.length)
        fail('OPTION_TEXTS_NOT_DISTINCT', `${where}:${locale}`);
      if (question.text[locale] === model.variants[vi].questions[qi].text[locale]) continue;
      const stem = clean(question.text[locale]).toLowerCase();
      const repeats = next.some((variant) =>
        variant.questions.some(
          (other) => other !== question && clean(other.text[locale]).toLowerCase() === stem,
        ),
      );
      if (repeats) fail('STEM_DUPLICATE', `${where}:${locale}`);
    }
  }
  return { errors, warnings, next, touched };
}

/** Every text that differs between two models, and the per-locale tally --plan prints. */
export function diffModels(before, next) {
  const edits = [];
  for (const [vi, variant] of before.entries()) {
    for (const [qi, question] of variant.questions.entries()) {
      const changed = next[vi].questions[qi];
      for (const locale of LOCALES) {
        if (question.text[locale] !== changed.text[locale])
          edits.push({
            variant: variant.variantNumber,
            question: qi + 1,
            questionId: question.id,
            kind: 'stem',
            locale,
            from: question.text[locale],
            to: changed.text[locale],
          });
        for (const [oi, option] of question.options.entries())
          if (option.text[locale] !== changed.options[oi].text[locale])
            edits.push({
              variant: variant.variantNumber,
              question: qi + 1,
              questionId: question.id,
              optionId: option.id,
              kind: option.id === question.correctOptionId ? 'correct' : 'option',
              locale,
              from: option.text[locale],
              to: changed.options[oi].text[locale],
            });
      }
    }
  }
  const summary = Object.fromEntries(
    LOCALES.map((locale) => {
      const mine = edits.filter((edit) => edit.locale === locale);
      return [
        locale,
        {
          wrongOptions: mine.filter((edit) => edit.kind === 'option').length,
          correctOptions: mine.filter((edit) => edit.kind === 'correct').length,
          questionTexts: mine.filter((edit) => edit.kind === 'stem').length,
          questions: new Set(mine.map((edit) => edit.questionId)).size,
        },
      ];
    }),
  );
  return { edits, summary };
}

/** The editor-shaped Russian bank and the kk/en/zh import payloads for the next revision. */
export function buildPayloads(variants) {
  const bank = variants.map((variant) => ({
    id: variant.stableId,
    variantNumber: variant.variantNumber,
    questions: variant.questions.map((question, qi) => ({
      id: question.id,
      text: clean(question.text.ru),
      displayOrder: qi + 1,
      options: question.options.map((option, oi) => ({
        id: option.id,
        text: clean(option.text.ru),
        displayOrder: oi + 1,
      })),
      correctOptionId: question.correctOptionId,
      explanation: clean(question.explanation.ru ?? ''),
    })),
  }));
  const localized = Object.fromEntries(
    TRANSLATED.map((locale) => [
      locale,
      variants.map((variant) => ({
        id: variant.stableId,
        variantNumber: variant.variantNumber,
        questions: variant.questions.map((question, qi) => ({
          id: question.id,
          text: question.text[locale],
          explanation: question.explanation[locale] ?? '',
          displayOrder: qi + 1,
          options: question.options.map((option, oi) => ({
            id: option.id,
            text: option.text[locale],
            displayOrder: oi + 1,
          })),
        })),
      })),
    ]),
  );
  return { bank, localized };
}

const bankProjection = (variants) =>
  (Array.isArray(variants) ? variants : []).map((variant) => ({
    id: variant.id,
    variantNumber: Number(variant.variantNumber),
    questions: (variant.questions ?? []).map((question) => ({
      id: question.id,
      text: clean(question.text),
      correctOptionId: question.correctOptionId ?? null,
      explanation: clean(question.explanation ?? ''),
      options: (question.options ?? []).map((option) => ({
        id: option.id,
        text: clean(option.text),
      })),
    })),
  }));
const wordingProjection = (variants) =>
  (Array.isArray(variants) ? variants : [])
    .map((variant) => ({
      id: variant.id,
      variantNumber: Number(variant.variantNumber),
      questions: (variant.questions ?? []).map((question) => ({
        id: question.id,
        text: question.text,
        explanation: question.explanation ?? '',
        options: (question.options ?? []).map((option) => ({ id: option.id, text: option.text })),
      })),
    }))
    .sort((a, b) => a.variantNumber - b.variantNumber);

/**
 * Where the draft stands against the live revision (`clean`), against exactly this rewrite
 * (`in-progress`, an interrupted run) or neither (`foreign`: somebody's unpublished work).
 */
export function inspectDraft(rows, model, payloads) {
  const live = buildPayloads(model.variants);
  const result = { course: 'clean', locales: {} };
  if (rows.draft.content_hash !== model.contentHash) {
    const scalars = COURSE_FIELDS.every((key) => sameJson(rows.draft[key], model.revision[key]));
    result.course =
      scalars &&
      sameJson(bankProjection(rows.draft.question_variants), bankProjection(payloads.bank))
        ? 'in-progress'
        : 'foreign';
  }
  for (const locale of TRANSLATED) {
    const draft = rows.draftLocalizations.find((item) => item.locale === locale);
    if (!draft) {
      result.locales[locale] = { missing: true };
      continue;
    }
    const pendingFields = META_FIELDS.filter(
      (key) => !sameJson(draft[key], model.localizations[locale][key]),
    );
    const mapped = rows.draftMappings.find((item) => item.locale === locale)?.presentation_id;
    if (mapped !== model.presentations[locale]) pendingFields.push('presentation');
    const wording = wordingProjection(draft.question_variants);
    result.locales[locale] = {
      status: draft.status,
      pendingFields,
      wording: sameJson(wording, wordingProjection(live.localized[locale]))
        ? 'clean'
        : sameJson(wording, wordingProjection(payloads.localized[locale]))
          ? 'in-progress'
          : 'foreign',
    };
  }
  return result;
}

export function draftBlockers(inspection, pendingDraft) {
  const blockers = [];
  if (inspection.course === 'foreign') blockers.push('DRAFT_HAS_UNPUBLISHED_COURSE_CHANGES');
  for (const [locale, state] of Object.entries(inspection.locales)) {
    if (state.missing) blockers.push(`DRAFT_LOCALIZATION_MISSING:${locale}`);
    else if (state.wording === 'foreign') blockers.push(`DRAFT_HAS_UNPUBLISHED_WORDING:${locale}`);
    else if (state.pendingFields.length > 0 && !pendingDraft)
      blockers.push(
        `PENDING_DRAFT_DECISION_REQUIRED:${locale}:${state.pendingFields.join('+')} (--pending-draft=publish|discard)`,
      );
  }
  return blockers;
}

/** The kk/en/zh metadata and presentations the next revision carries. */
export function chosenLocalizations(rows, model, pendingDraft) {
  return Object.fromEntries(
    TRANSLATED.map((locale) => {
      if (pendingDraft !== 'publish')
        return [
          locale,
          { ...model.localizations[locale], presentationId: model.presentations[locale] },
        ];
      const draft = rows.draftLocalizations.find((item) => item.locale === locale);
      return [
        locale,
        {
          ...Object.fromEntries(META_FIELDS.map((key) => [key, draft[key]])),
          presentationId: rows.draftMappings.find((item) => item.locale === locale)
            ?.presentation_id,
        },
      ];
    }),
  );
}

/** Everything --plan decides, without I/O. `ok` is false when the rewrite is refused. */
export function planRewrite({ rows, rewrite, base, pendingDraft = null }) {
  const { model, problems } = readModel(rows);
  const validation =
    problems.length === 0
      ? validateRewrite({ rewrite, base, model })
      : { errors: [], warnings: [], next: null };
  const errors = [...problems, ...validation.errors];
  const checks = CHECKS.map(([name, pattern]) => {
    const failed = errors.filter((error) => pattern.test(error));
    return failed.length ? { check: name, ok: false, failures: failed } : { check: name, ok: true };
  });
  const unclassified = errors.filter((error) => !CHECKS.some(([, pattern]) => pattern.test(error)));
  if (unclassified.length)
    checks.push({
      check: 'rewrite and export files well-formed',
      ok: false,
      failures: unclassified,
    });
  if (errors.length) return { ok: false, model, errors, warnings: validation.warnings, checks };
  const { edits, summary } = diffModels(model.variants, validation.next);
  const payloads = buildPayloads(validation.next);
  const inspection = inspectDraft(rows, model, payloads);
  const blockers = draftBlockers(inspection, pendingDraft);
  checks.push({
    check: 'draft free of unpublished work the run would overwrite',
    ok: blockers.length === 0,
    ...(blockers.length ? { failures: blockers } : {}),
  });
  return {
    ok: true,
    model,
    next: validation.next,
    payloads,
    edits,
    summary,
    inspection,
    blockers,
    warnings: validation.warnings,
    checks,
  };
}

/** Re-read after publication: identity and answer key kept, texts as intended, four locales. */
export function verifyPublished({ before, next, localizations, afterRows }) {
  const failures = [];
  const { model: after, problems } = readModel(afterRows);
  failures.push(...problems);
  if (after.revisionId === before.revisionId) failures.push('NEW_REVISION_MISSING');
  if (after.version !== before.version + 1) failures.push('REVISION_VERSION_UNEXPECTED');
  if (afterRows.draft.content_hash !== after.contentHash) failures.push('DRAFT_DIFFERS_FROM_LIVE');
  if (afterRows.variantLocalizations.length !== 12) failures.push('LOCALIZED_VARIANTS_INCOMPLETE');
  for (const [vi, variant] of before.variants.entries()) {
    const published = after.variants[vi];
    if (
      published?.stableId !== variant.stableId ||
      published.variantNumber !== variant.variantNumber
    ) {
      failures.push(`VARIANT_IDENTITY_CHANGED:v${variant.variantNumber}`);
      continue;
    }
    for (const [qi, question] of variant.questions.entries()) {
      const where = `v${variant.variantNumber}:q${qi + 1}`;
      const now = published.questions[qi];
      if (now?.id !== question.id) {
        failures.push(`QUESTION_IDENTITY_CHANGED:${where}`);
        continue;
      }
      if (now.correctOptionId !== question.correctOptionId)
        failures.push(`ANSWER_KEY_CHANGED:${where}`);
      if (!sameJson(now.explanation, question.explanation))
        failures.push(`EXPLANATION_CHANGED:${where}`);
      if (now.options.map((o) => o.id).join() !== question.options.map((o) => o.id).join())
        failures.push(`OPTION_ORDER_CHANGED:${where}`);
      const expected = next[vi].questions[qi];
      for (const locale of LOCALES) {
        if (now.text[locale] !== expected.text[locale])
          failures.push(`STEM_NOT_AS_INTENDED:${where}:${locale}`);
        for (const [oi, option] of now.options.entries())
          if (option.text[locale] !== expected.options[oi]?.text[locale])
            failures.push(`OPTION_NOT_AS_INTENDED:${where}:o${oi + 1}:${locale}`);
      }
    }
  }
  if (!sameJson(after.localizations.ru, before.localizations.ru))
    failures.push('RU_METADATA_CHANGED');
  for (const locale of TRANSLATED) {
    const { presentationId, ...meta } = localizations[locale];
    if (!sameJson(after.localizations[locale], meta))
      failures.push(`METADATA_NOT_AS_INTENDED:${locale}`);
    if (after.presentations[locale] !== presentationId)
      failures.push(`PRESENTATION_CHANGED:${locale}`);
  }
  if (after.presentations.ru !== before.presentations.ru) failures.push('PRESENTATION_CHANGED:ru');
  return { failures, after };
}

export function parseArguments(argv) {
  const options = parseCommonArguments(argv, { names: ['rewrite', 'base'], required: ['rewrite'] });
  const rewrite = options.values.rewrite;
  return {
    ...options,
    rewrite: path.resolve(rewrite),
    base: path.resolve(
      options.values.base ??
        path.join(path.dirname(rewrite), '..', 'input', path.basename(rewrite)),
    ),
  };
}

async function readRows(service, slug) {
  const one = async (query, what) => {
    const { data, error } = await query;
    if (error) throw new RewriteError('TARGET_READ_FAILED', [what, error.message]);
    return data;
  };
  const test = await one(
    service
      .from('tests')
      .select('id,slug,status,current_revision_id,content_version,content_hash,draft_content')
      .eq('slug', slug)
      .maybeSingle(),
    'tests',
  );
  if (!test) throw new RewriteError('COURSE_NOT_FOUND', [slug]);
  const revisionId = test.current_revision_id;
  const [
    revision,
    variants,
    localizations,
    variantLocalizations,
    mappings,
    draft,
    draftLocalizations,
    draftMappings,
  ] = await Promise.all([
    one(
      service
        .from('test_revisions')
        .select(`id,version,content_hash,published_at,${COURSE_FIELDS.join(',')}`)
        .eq('id', revisionId)
        .maybeSingle(),
      'test_revisions',
    ),
    one(
      service
        .from('test_revision_variants')
        .select('id,stable_id,variant_number,questions')
        .eq('revision_id', revisionId),
      'test_revision_variants',
    ),
    one(
      service
        .from('test_revision_localizations')
        .select(`locale,content_hash,${META_FIELDS.join(',')}`)
        .eq('revision_id', revisionId),
      'test_revision_localizations',
    ),
    one(
      service
        .from('test_revision_variant_localizations')
        .select('variant_id,locale,questions,explanations')
        .eq('revision_id', revisionId),
      'test_revision_variant_localizations',
    ),
    one(
      service
        .from('test_revision_presentations')
        .select('locale,presentation_id')
        .eq('revision_id', revisionId),
      'test_revision_presentations',
    ),
    one(
      service
        .from('course_drafts')
        .select(`test_id,draft_version,content_hash,question_variants,${COURSE_FIELDS.join(',')}`)
        .eq('test_id', test.id)
        .maybeSingle(),
      'course_drafts',
    ),
    one(
      service
        .from('course_draft_localizations')
        .select(
          `locale,status,draft_version,content_hash,reviewed_content_hash,translation_qa,question_variants,${META_FIELDS.join(',')}`,
        )
        .eq('test_id', test.id),
      'course_draft_localizations',
    ),
    one(
      service
        .from('course_draft_presentations')
        .select('locale,presentation_id')
        .eq('test_id', test.id),
      'course_draft_presentations',
    ),
  ]);
  if (!draft) throw new RewriteError('COURSE_DRAFT_NOT_FOUND', [slug]);
  return {
    test,
    revision,
    variants,
    localizations,
    variantLocalizations,
    mappings,
    draft,
    draftLocalizations,
    draftMappings,
  };
}

/** Local stand only: the private answer-key table itself, through the Docker Postgres port. */
async function privateAnswerKeys(revisionId, local) {
  const connectionString = process.env.DATABASE_URL;
  if (
    !local ||
    !connectionString ||
    !['127.0.0.1', 'localhost'].includes(new URL(connectionString).hostname)
  )
    return null;
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('begin read only');
    const { rows } = await client.query(
      `select variant.stable_id, key.correct_option_ids, key.explanations
         from public.test_revision_variants variant
         join private.test_revision_variant_answer_keys key on key.variant_id = variant.id
        where variant.revision_id = $1`,
      [revisionId],
    );
    await client.query('rollback');
    return new Map(rows.map((row) => [row.stable_id, row]));
  } finally {
    await client.end();
  }
}

function privateKeysMatch(keys, model) {
  if (!keys) return 'not-read (service-key witness only)';
  const ok = model.variants.every((variant) => {
    const row = keys.get(variant.stableId);
    return (
      row &&
      sameJson(
        row.correct_option_ids,
        variant.questions.map((q) => q.correctOptionId),
      ) &&
      sameJson(
        row.explanations,
        variant.questions.map((q) => q.explanation.ru),
      )
    );
  });
  if (!ok) throw new RewriteError('PRIVATE_ANSWER_KEY_MISMATCH', [model.revisionId]);
  return 'verified';
}

const MAX_RATE_LIMIT_RETRIES = 12;
/** save_course_draft_v3 is not in the Stage 6 repository; same retry rule, message preserved. */
async function saveCourseDraft(operator, args) {
  for (let attempt = 0; ; attempt += 1) {
    const { data, error } = await operator.rpc('save_course_draft_v3', args);
    const issue = error ?? data?.__safetyhubRpcError;
    const wait = /RATE_LIMITED:([0-9]{1,4})/u.exec(issue?.message ?? '');
    if (wait && attempt < MAX_RATE_LIMIT_RETRIES) {
      await new Promise((resolve) =>
        setTimeout(resolve, (Math.min(Number(wait[1]), 600) + 1) * 1000),
      );
      continue;
    }
    if (issue) throw new RewriteError('SAVE_COURSE_DRAFT_FAILED', [issue.message]);
    return data;
  }
}

async function applyRewrite({
  service,
  repo,
  operator,
  actorId,
  slug,
  plan,
  options,
  rewriteSha256,
  local,
}) {
  const { model, payloads, next } = plan;
  const courseId = model.courseId;
  const localizations = chosenLocalizations(
    await readRows(service, slug),
    model,
    options.pendingDraft,
  );
  const keysBefore = privateKeysMatch(await privateAnswerKeys(model.revisionId, local), model);
  let rows = await readRows(service, slug);
  if (rows.test.current_revision_id !== model.revisionId)
    throw new RewriteError('LIVE_REVISION_MOVED');
  // 1. The Russian bank, rebuilt from the live revision with the new wrong options.
  if (plan.inspection.course === 'clean') {
    const r = model.revision;
    await saveCourseDraft(operator, {
      p_actor_id: actorId,
      p_test_id: courseId,
      p_expected_version: rows.draft.draft_version,
      p_slug: r.slug,
      p_title: r.title,
      p_description: r.description,
      p_icon: r.icon,
      p_display_order: r.display_order,
      p_presentation_id: r.presentation_id,
      p_duration_minutes: r.duration_minutes,
      p_pass_score: r.pass_score,
      p_attempts_per_calendar_day: r.attempts_per_calendar_day,
      p_attempt_reset_timezone: r.attempt_reset_timezone,
      p_question_variants: payloads.bank,
      p_seo: r.seo,
      p_content_metadata: {
        jurisdiction: r.jurisdiction ?? '',
        effectiveDate: r.effective_date ?? '',
        sources: r.sources ?? [],
      },
    });
  }
  // 2. kk/en/zh: metadata as decided, the new wording through the trusted import, then the
  // review receipt at the imported hash — the batch publisher's order.
  const reread = async (locale) => {
    rows = await readRows(service, slug);
    return rows.draftLocalizations.find((item) => item.locale === locale);
  };
  for (const locale of TRANSLATED) {
    const { presentationId, ...meta } = localizations[locale];
    let loc = await reread(locale);
    const args = (reviewed, qa) => ({
      p_actor_id: actorId,
      p_test_id: courseId,
      p_locale: locale,
      p_expected_version: loc.draft_version,
      p_title: meta.title,
      p_description: meta.description,
      p_content: meta.content,
      p_question_variants: [],
      p_seo: meta.seo,
      p_sources: meta.sources,
      p_reviewed_content_hash: reviewed,
      p_translation_qa: qa,
      p_presentation_id: presentationId,
    });
    const mapped = rows.draftMappings.find((item) => item.locale === locale)?.presentation_id;
    if (META_FIELDS.some((key) => !sameJson(loc[key], meta[key])) || mapped !== presentationId) {
      await repo.saveCourseLocalization(args(null, loc.translation_qa));
      loc = await reread(locale);
    }
    if (
      !sameJson(
        wordingProjection(loc.question_variants),
        wordingProjection(payloads.localized[locale]),
      )
    ) {
      await repo.importCourseAssessment({
        p_actor_id: actorId,
        p_test_id: courseId,
        p_locale: locale,
        p_expected_version: loc.draft_version,
        p_question_variants: payloads.localized[locale],
      });
      loc = await reread(locale);
    }
    if (loc.status !== 'complete' || loc.reviewed_content_hash !== loc.content_hash) {
      await repo.saveCourseLocalization(
        args(loc.content_hash, {
          ...loc.translation_qa,
          status: 'passed',
          assessmentImported: true,
          optionRewrite: { rewriteSha256, reviewedAt: new Date().toISOString() },
        }),
      );
      loc = await reread(locale);
    }
    if (loc.status !== 'complete' || loc.reviewed_content_hash !== loc.content_hash)
      throw new RewriteError('LOCALIZATION_NOT_COMPLETE', [locale]);
  }
  // 3. Russian follows the bank through the course_drafts trigger; 4. publish all four.
  rows = await readRows(service, slug);
  const ru = rows.draftLocalizations.find((item) => item.locale === 'ru');
  if (ru?.status !== 'complete' || ru.reviewed_content_hash !== ru.content_hash)
    throw new RewriteError('LOCALIZATION_NOT_COMPLETE', ['ru']);
  if (rows.test.current_revision_id !== model.revisionId)
    throw new RewriteError('LIVE_REVISION_MOVED');
  const published = await repo.publishCourse({
    p_actor_id: actorId,
    p_test_id: courseId,
    p_expected_content_hash: rows.draft.content_hash,
  });
  if (!UUID.test(published.revisionId ?? '') || published.locales?.length !== 4)
    throw new RewriteError('PUBLICATION_RECEIPT_INVALID');
  // 5. Re-read what learners now get.
  const afterRows = await readRows(service, slug);
  const { failures, after } = verifyPublished({ before: model, next, localizations, afterRows });
  if (after.revisionId !== published.revisionId)
    failures.push('LIVE_REVISION_NOT_THE_PUBLISHED_ONE');
  let keysAfter = 'not-read';
  try {
    keysAfter = privateKeysMatch(await privateAnswerKeys(after.revisionId, local), after);
  } catch (error) {
    failures.push(error.message);
  }
  if (failures.length)
    throw new RewriteError('PUBLISHED_REVISION_VERIFICATION_FAILED', [
      `revision ${published.revisionId} IS live`,
      ...failures,
    ]);
  return {
    revisionId: after.revisionId,
    version: after.version,
    previousRevisionId: model.revisionId,
    locales: published.locales,
    verification: {
      answerKey: 'unchanged (ids, order, correct options, explanations)',
      texts: 'as intended in ru/kk/en/zh',
      localesPublished: LOCALES.filter((locale) =>
        afterRows.localizations.some((l) => l.locale === locale),
      ),
      privateAnswerKeys: { before: keysBefore, after: keysAfter },
      draftEqualsLive: true,
    },
  };
}

export async function run(argv, environment = process.env) {
  const options = parseArguments(argv);
  const rewriteBytes = await readFile(options.rewrite);
  const rewriteSha256 = sha256(rewriteBytes);
  const rewrite = JSON.parse(rewriteBytes.toString('utf8'));
  const baseBytes = await readFile(options.base).catch(() => {
    throw new RewriteError('BASE_REQUIRED', [options.base]);
  });
  const base = JSON.parse(baseBytes.toString('utf8'));
  const target = await connectTarget(options, rewriteSha256, environment);
  const { service, local, host } = target;
  const rows = await readRows(service, rewrite?.slug);
  const plan = planRewrite({ rows, rewrite, base, pendingDraft: options.pendingDraft });
  const report = {
    ok: plan.ok,
    mode: options.mode,
    target: options.target,
    host,
    slug: rewrite.slug,
    rewrite: { file: options.rewrite, sha256: rewriteSha256 },
    base: {
      file: options.base,
      sha256: sha256(baseBytes),
      revisionId: base.revisionId ?? null,
      version: base.version ?? null,
    },
    live: {
      courseId: plan.model.courseId,
      revisionId: plan.model.revisionId,
      version: plan.model.version,
      unchangedSinceExport: base.revisionId === plan.model.revisionId,
    },
    checks: plan.checks,
    ...(plan.ok
      ? {
          changes: plan.summary,
          draft: plan.inspection,
          applyReady: plan.blockers.length === 0 && plan.edits.length > 0,
          ...(plan.edits.length === 0 ? { alreadyApplied: true } : {}),
        }
      : { errors: plan.errors }),
    warnings: plan.warnings,
    ...(options.diff && plan.ok
      ? {
          edits: plan.edits.map(
            (e) =>
              `v${e.variant} q${e.question} ${e.kind}${e.optionId ? ` ${e.optionId}` : ''} ${e.locale}: «${e.from}» → «${e.to}»`,
          ),
        }
      : {}),
  };
  if (!local && options.mode === 'plan') report.applyWith = `--confirm-hash=${rewriteSha256}`;
  if (options.mode === 'plan' || !plan.ok || plan.edits.length === 0) return report;
  if (plan.blockers.length) throw new RewriteError('DRAFT_BLOCKED', plan.blockers);
  const { repo, operator, actorId } = await operatorRepository({
    ...target,
    operatorEmail: options.operatorEmail,
    receipt: rewriteSha256,
  });
  report.published = await applyRewrite({
    service,
    repo,
    operator,
    actorId,
    slug: rewrite.slug,
    plan,
    options,
    rewriteSha256,
    local,
  });
  return report;
}

await runCli(import.meta.url, run);
