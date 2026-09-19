import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';
import { contentSeoSchema } from '../lib/validation/content-seo.ts';
import { createSupabaseRepository } from './publish-stage6-localizations.mjs';
import {
  CURRENT_PRODUCTION_PROJECT_REF,
  assertLinkedProductionProjectRef,
} from './production-operator-safety.mjs';

export const COURSE_BATCH_SLUGS = ['svarshchik', 'promyshlennaya-bezopasnost'];
export const COURSE_BATCH_LOCALES = ['ru', 'kk', 'en', 'zh'];
const ROOT = path.resolve('content/course-batch-2026-09');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
async function json(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export function validateAssessment(variants, sourceVariants = null, locale = 'ru') {
  assert(Array.isArray(variants) && variants.length === 3, 'ASSESSMENT_VARIANTS_INVALID');
  const ids = new Set();
  const texts = new Set();
  const uniqueId = (id) => {
    assert(UUID.test(id ?? '') && !ids.has(id), 'ASSESSMENT_ID_INVALID');
    ids.add(id);
  };
  for (const [vi, variant] of variants.entries()) {
    uniqueId(variant.id);
    assert(
      variant.variantNumber === vi + 1 && variant.questions?.length === 10,
      'ASSESSMENT_QUESTIONS_INVALID',
    );
    if (sourceVariants)
      assert(variant.id === sourceVariants[vi].id, 'TRANSLATION_VARIANT_MISMATCH');
    for (const [qi, q] of variant.questions.entries()) {
      uniqueId(q.id);
      // Chinese expresses a complete question in fewer characters than alphabetic languages.
      const minimumQuestionLength = locale === 'zh' ? 5 : 11;
      assert(
        typeof q.text === 'string' &&
          [...q.text.trim()].length >= minimumQuestionLength &&
          !texts.has(q.text.trim()),
        'ASSESSMENT_TEXT_INVALID',
      );
      texts.add(q.text.trim());
      assert(
        q.options?.length === 4 && new Set(q.options.map((o) => o.text.trim())).size === 4,
        'ASSESSMENT_OPTIONS_INVALID',
      );
      assert(
        q.options.some((o) => o.id === q.correctOptionId),
        'ASSESSMENT_ANSWER_INVALID',
      );
      assert(
        typeof q.explanation === 'string' && q.explanation.trim().length > 10,
        'ASSESSMENT_EXPLANATION_MISSING',
      );
      for (const [oi, o] of q.options.entries()) {
        uniqueId(o.id);
        assert(typeof o.text === 'string' && o.text.trim(), 'ASSESSMENT_OPTION_EMPTY');
        if (sourceVariants)
          assert(
            o.id === sourceVariants[vi].questions[qi].options[oi].id,
            'TRANSLATION_OPTION_MISMATCH',
          );
      }
      if (sourceVariants) {
        const source = sourceVariants[vi].questions[qi];
        assert(
          q.id === source.id && q.correctOptionId === source.correctOptionId,
          'TRANSLATION_ANSWER_MISMATCH',
        );
      }
    }
  }
}

export function assessmentProjection(variants, includeAnswers = false) {
  return variants.map((v) => ({
    id: v.id,
    variantNumber: v.variantNumber,
    questions: v.questions.map((q, i) => ({
      id: q.id,
      text: q.text,
      displayOrder: i + 1,
      explanation: q.explanation,
      options: q.options.map((o, j) => ({ id: o.id, text: o.text, displayOrder: j + 1 })),
      ...(includeAnswers ? { correctOptionId: q.correctOptionId } : {}),
    })),
  }));
}

export async function loadCourseBatch(root = ROOT) {
  const review = await json(path.join(root, 'release-review.json'));
  assert(
    review.status === 'passed' && review.independentReviewer && review.reviewedAt,
    'INDEPENDENT_REVIEW_REQUIRED',
  );
  const entries = [];
  for (const slug of COURSE_BATCH_SLUGS) {
    let sourceVariants;
    for (const locale of COURSE_BATCH_LOCALES) {
      const dir = path.join(root, slug, locale);
      const deckBytes = await readFile(path.join(dir, 'deck.json'));
      const assessmentBytes = await readFile(path.join(dir, 'assessment.json'));
      const deck = JSON.parse(deckBytes);
      const assessment = JSON.parse(assessmentBytes);
      const variants = assessment.variants;
      const pdf = await readFile(path.join(dir, 'presentation.pdf'));
      const pageCount = (await PDFDocument.load(pdf)).getPageCount();
      const receipt = review.entries?.find((e) => e.slug === slug && e.locale === locale);
      assert(
        receipt &&
          receipt.deckSha256 === hash(deckBytes) &&
          receipt.assessmentSha256 === hash(assessmentBytes) &&
          receipt.pdfSha256 === hash(pdf) &&
          receipt.visual === 'passed' &&
          receipt.semantic === 'passed',
        `UNREVIEWED_ARTIFACT:${slug}:${locale}`,
      );
      assert(
        deck.slug === slug && deck.locale === locale && pageCount === deck.slides.length,
        'DECK_IDENTITY_INVALID',
      );
      assert(
        pageCount >= (slug === 'svarshchik' ? 40 : 50) &&
          pageCount <= (slug === 'svarshchik' ? 45 : 59),
        'DECK_LENGTH_INVALID',
      );
      assert(pdf.length <= 25 * 1024 * 1024, 'PRESENTATION_TOO_LARGE');
      contentSeoSchema.parse(deck.seo);
      validateAssessment(variants, sourceVariants, locale);
      if (locale === 'ru') sourceVariants = variants;
      entries.push({
        slug,
        locale,
        deck,
        variants,
        presentation: {
          pdf: { bytes: pdf },
          sha256: hash(pdf),
          byteSize: pdf.length,
          pageCount,
          sourceFilename: `${slug}-${locale}.pdf`,
        },
      });
    }
  }
  return { entries, review, batchHash: hash(JSON.stringify(review)) };
}

async function rpc(client, name, args) {
  const { data, error } = await client.rpc(name, args);
  const issue = error ?? data?.__safetyhubRpcError;
  if (issue) throw new Error(`${name}:${issue.code ?? ''}:${issue.message ?? 'RPC_FAILED'}`);
  assert(data && typeof data === 'object', `${name}:EMPTY_RECEIPT`);
  return data;
}

async function operatorSession(service, url, secret, local) {
  let token = process.env.SAFETYHUB_CONTENT_OPERATOR_ACCESS_TOKEN;
  // Generate and consume a link only for the synthetic LOCAL operator. No mail is sent.
  if (!token && local) {
    const link = await service.auth.admin.generateLink({
      type: 'magiclink',
      email: 'admin@safetyhub.local',
    });
    if (link.error) throw new Error('LOCAL_OPERATOR_MISSING');
    const auth = createClient(url, secret, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const verified = await auth.auth.verifyOtp({
      token_hash: link.data.properties.hashed_token,
      type: 'magiclink',
    });
    if (verified.error) throw new Error('LOCAL_OPERATOR_SESSION_FAILED');
    token = verified.data.session?.access_token;
  }
  assert(token, 'OPERATOR_SESSION_REQUIRED');
  const operator = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const user = await operator.auth.getUser(token);
  assert(!user.error && user.data.user, 'OPERATOR_SESSION_INVALID');
  return { token, operator, actorId: user.data.user.id };
}

export async function publishCourseBatch({ batch, target, receiptPath, confirmHash }) {
  assert(confirmHash === batch.batchHash, 'REVIEWED_BATCH_HASH_REQUIRED');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  assert(url && secret, 'ENVIRONMENT_REQUIRED');
  const host = new URL(url).hostname;
  const local = ['127.0.0.1', 'localhost'].includes(host);
  assert(target === (local ? 'local' : 'production'), 'TARGET_MISMATCH');
  if (!local) {
    assert(host === `${CURRENT_PRODUCTION_PROJECT_REF}.supabase.co`, 'PRODUCTION_TARGET_MISMATCH');
    await assertLinkedProductionProjectRef(CURRENT_PRODUCTION_PROJECT_REF);
  }
  const service = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { token, operator, actorId } = await operatorSession(service, url, secret, local);
  const repo = createSupabaseRepository({
    url,
    serviceSecret: secret,
    operatorAccessToken: token,
    root: process.cwd(),
    batchHash: batch.batchHash,
    reviewedAt: batch.review.reviewedAt,
  });
  await repo.assertOperator(actorId);
  await Promise.all(
    ['course-presentations', 'course-presentations-staging'].map((b) =>
      repo.assertPrivateBucket(b),
    ),
  );
  let receipt;
  try {
    receipt = await json(receiptPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (receipt)
    assert(
      receipt.target === host && receipt.batchHash === batch.batchHash,
      'RECEIPT_TARGET_CONFLICT',
    );
  else
    receipt = {
      schemaVersion: 1,
      target: host,
      batchHash: batch.batchHash,
      courses: {},
      startedAt: new Date().toISOString(),
    };
  const persist = async () => {
    await mkdir(path.dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  };
  const catalog = await service
    .from('tests')
    .select('id,slug,display_order,current_revision_id,content_version');
  if (catalog.error) throw new Error('CATALOG_READ_FAILED');
  const oldCourses = catalog.data.filter((c) => !COURSE_BATCH_SLUGS.includes(c.slug));
  const qa = {
    status: 'passed',
    mode: 'automated-only',
    batchSha256: batch.batchHash,
    independentSemanticReviewSha256: hash(JSON.stringify(batch.review)),
    humanApproval: false,
  };
  for (const [index, slug] of COURSE_BATCH_SLUGS.entries()) {
    const items = batch.entries.filter((e) => e.slug === slug);
    const ru = items[0];
    let entry = receipt.courses[slug];
    const found = catalog.data.find((c) => c.slug === slug);
    if (found) assert(entry?.id === found.id, 'EXISTING_COURSE_REQUIRES_MATCHING_RECEIPT');
    const sources = ru.deck.sources
      .filter((s) => s.url && s.title)
      .map(({ title, url }) => ({ title, url }))
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
    const saveArgs = (id, version, presentationId, displayOrder) => ({
      p_actor_id: actorId,
      p_test_id: id,
      p_expected_version: version,
      p_slug: slug,
      p_title: ru.deck.title,
      p_description: ru.deck.description,
      p_icon: slug === 'svarshchik' ? 'goggles' : 'factory',
      p_display_order: displayOrder,
      p_presentation_id: presentationId,
      p_duration_minutes: 15,
      p_pass_score: 7,
      p_attempts_per_calendar_day: 8,
      p_attempt_reset_timezone: 'Asia/Oral',
      p_question_variants: assessmentProjection(ru.variants, true),
      p_seo: ru.deck.seo,
      p_content_metadata: {
        jurisdiction: 'Республика Казахстан',
        effectiveDate: batch.review.reviewedAt.slice(0, 10),
        sources,
      },
    });
    if (!entry) {
      const displayOrder = Math.max(0, ...oldCourses.map((c) => c.display_order)) + index + 1;
      const saved = await rpc(
        operator,
        'save_course_draft_v3',
        saveArgs(null, null, null, displayOrder),
      );
      entry = receipt.courses[slug] = {
        id: saved.id,
        displayOrder,
        draftVersion: saved.draftVersion,
        contentHash: saved.contentHash,
      };
      await persist();
    }
    let state = await repo.readCourse(entry.id);
    if (entry.publishedRevisionId) {
      assert(
        state.test.current_revision_id === entry.publishedRevisionId,
        'PUBLISHED_REVISION_CHANGED',
      );
      continue;
    }
    assert(state.draft.content_hash === entry.contentHash, 'DRAFT_CHANGED_OUTSIDE_BATCH');
    const presentations = {};
    for (const item of items)
      presentations[item.locale] = await repo.ensurePresentation(
        { ...item, courseId: entry.id },
        actorId,
      );
    const saved = await rpc(
      operator,
      'save_course_draft_v3',
      saveArgs(entry.id, state.draft.draft_version, presentations.ru.id, entry.displayOrder),
    );
    entry.contentHash = saved.contentHash;
    entry.draftVersion = saved.draftVersion;
    await persist();
    state = await repo.readCourse(entry.id);
    for (const item of items) {
      let loc = state.draftLocalizations.find((l) => l.locale === item.locale);
      const args = () => ({
        p_actor_id: actorId,
        p_test_id: entry.id,
        p_locale: item.locale,
        p_expected_version: loc?.draft_version ?? null,
        p_title: item.deck.title,
        p_description: item.deck.description,
        p_content: { modules: [] },
        p_question_variants: [],
        p_seo: item.deck.seo,
        p_sources: sources,
        p_reviewed_content_hash: null,
        p_translation_qa: qa,
        p_presentation_id: presentations[item.locale].id,
      });
      await repo.saveCourseLocalization(args());
      state = await repo.readCourse(entry.id);
      loc = state.draftLocalizations.find((l) => l.locale === item.locale);
      // Russian wording is inherited from the keyed source draft. The translation-only
      // import RPC deliberately rejects ru to protect that source-of-truth boundary.
      if (item.locale !== 'ru') {
        await repo.importCourseAssessment({
          p_actor_id: actorId,
          p_test_id: entry.id,
          p_locale: item.locale,
          p_expected_version: loc.draft_version,
          p_question_variants: assessmentProjection(item.variants),
        });
        state = await repo.readCourse(entry.id);
        loc = state.draftLocalizations.find((l) => l.locale === item.locale);
      }
      await repo.saveCourseLocalization({
        ...args(),
        p_reviewed_content_hash: loc.content_hash,
        p_translation_qa: { ...loc.translation_qa, ...qa, assessmentImported: true },
      });
      state = await repo.readCourse(entry.id);
      assert(
        state.draftLocalizations.find((l) => l.locale === item.locale)?.status === 'complete',
        'LOCALIZATION_NOT_COMPLETE',
      );
    }
    const published = await repo.publishCourse({
      p_actor_id: actorId,
      p_test_id: entry.id,
      p_expected_content_hash: state.draft.content_hash,
    });
    assert(
      published.locales?.length === 4 && UUID.test(published.revisionId),
      'PUBLICATION_RECEIPT_INVALID',
    );
    entry.publishedRevisionId = published.revisionId;
    await persist();
  }
  const after = await service
    .from('tests')
    .select('id,current_revision_id,content_version')
    .in(
      'id',
      oldCourses.map((c) => c.id),
    );
  assert(
    !after.error &&
      after.data.length === oldCourses.length &&
      after.data.every((row) => {
        const old = oldCourses.find((c) => c.id === row.id);
        return (
          old.current_revision_id === row.current_revision_id &&
          old.content_version === row.content_version
        );
      }),
    'EXISTING_COURSE_CHANGED',
  );
  receipt.completedAt = new Date().toISOString();
  await persist();
  return receipt;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const argv = process.argv.slice(2);
    const value = (n) => argv.find((a) => a.startsWith(n + '='))?.slice(n.length + 1);
    assert(
      argv.every(
        (a) => a === '--plan' || a === '--apply' || /^--(target|receipt|confirm-hash)=/.test(a),
      ),
      'UNKNOWN_ARGUMENT',
    );
    assert(argv.includes('--plan') !== argv.includes('--apply'), 'CHOOSE_PLAN_OR_APPLY');
    const batch = await loadCourseBatch();
    if (argv.includes('--plan'))
      console.log(
        JSON.stringify({
          ok: true,
          batchHash: batch.batchHash,
          courses: COURSE_BATCH_SLUGS,
          presentations: batch.entries.length,
          pages: batch.entries.reduce((a, e) => a + e.presentation.pageCount, 0),
        }),
      );
    else
      console.log(
        JSON.stringify({
          ok: true,
          receipt: await publishCourseBatch({
            batch,
            target: value('--target'),
            receiptPath: path.resolve(
              value('--receipt') ?? 'artifacts/course-batch-publication.json',
            ),
            confirmHash: value('--confirm-hash'),
          }),
        }),
      );
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}
