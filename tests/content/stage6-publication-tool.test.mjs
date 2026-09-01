import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  executeStage6Publication,
  parseCliArguments,
} from '../../scripts/publish-stage6-localizations.mjs';
import {
  assertNoAnswerKeys,
  loadStage6PublicationBatch,
  sha256,
  Stage6PublicationContractError,
} from '../../scripts/content-localization/stage6-publication-contract.mjs';
import { CURRENT_PRODUCTION_PROJECT_REF } from '../../scripts/production-operator-safety.mjs';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const REVISION_ID = '22222222-2222-4222-8222-222222222222';

function stable(value) {
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

function fakeHash(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function createFakeRepository(batch) {
  const courses = new Map();
  const presentations = new Map();
  const articles = new Map();
  const legal = new Map();
  const mutations = {
    presentations: 0,
    courseSaves: 0,
    assessmentImports: 0,
    coursePublishes: 0,
    articleSaves: 0,
    articlePublishes: 0,
    legalStages: 0,
    legalSaves: 0,
    legalPublishes: 0,
  };
  for (const entry of batch.courses) {
    if (!courses.has(entry.courseId)) {
      courses.set(entry.courseId, {
        test: {
          id: entry.courseId,
          slug: entry.slug,
          status: 'published',
          current_revision_id: null,
          content_version: 1,
        },
        draft: { test_id: entry.courseId, content_hash: 'a'.repeat(64), draft_version: 1 },
        draftLocalizations: [],
        draftMappings: [],
        presentations: [],
        current: null,
      });
    }
  }
  for (const entry of batch.articles) {
    if (!articles.has(entry.slug)) {
      articles.set(entry.slug, {
        article: {
          id: `30000000-0000-4000-8000-${String(articles.size + 1).padStart(12, '0')}`,
          slug: entry.slug,
          status: 'published',
          is_published: true,
          current_revision_id: null,
          content_version: 1,
        },
        draft: { content_hash: 'b'.repeat(64), draft_version: 1 },
        draftLocalizations: [],
        current: null,
      });
    }
  }
  for (const document of batch.legal) {
    legal.set(`${document.documentType}:${document.historicalVersion}`, {
      version: {
        document_type: document.documentType,
        version: document.historicalVersion,
        body_revision: `${document.documentType}-${document.historicalVersion}`,
        effective_at: '2026-08-31T00:00:00.000Z',
        is_current: true,
      },
      localizations: [
        {
          locale: 'ru',
          title: 'RU',
          body: { bodyRevision: `${document.documentType}-${document.historicalVersion}` },
          body_hash: 'c'.repeat(64),
          status: 'published',
        },
      ],
    });
  }

  function courseClone(course) {
    return structuredClone(course);
  }

  return {
    mutations,
    async assertOperator(actorId) {
      assert.equal(actorId, ACTOR_ID);
    },
    async assertPrivateBucket(bucket) {
      assert.ok(['course-presentations-staging', 'course-presentations'].includes(bucket));
    },
    async ensurePresentation(entry) {
      const key = `${entry.courseId}:${entry.locale}`;
      const existing = presentations.get(key);
      if (existing) return { ...existing, replayed: true };
      mutations.presentations += 1;
      const result = {
        id: `40000000-0000-4000-8000-${String(presentations.size + 1).padStart(12, '0')}`,
        sha256: entry.presentation.sha256,
        pageCount: entry.presentation.pageCount,
        replayed: false,
      };
      presentations.set(key, result);
      const course = courses.get(entry.courseId);
      course.presentations.push({
        id: result.id,
        course_id: entry.courseId,
        locale: entry.locale,
        status: 'ready',
        sha256: result.sha256,
        page_count: result.pageCount,
        byte_size: entry.presentation.byteSize,
      });
      return result;
    },
    async readCourse(courseId) {
      return courseClone(courses.get(courseId));
    },
    async saveCourseLocalization(args) {
      mutations.courseSaves += 1;
      const course = courses.get(args.p_test_id);
      let row = course.draftLocalizations.find((item) => item.locale === args.p_locale);
      if (row) assert.equal(args.p_expected_version, row.draft_version);
      else assert.equal(args.p_expected_version, null);
      const variants = row?.question_variants ?? [];
      const contentHash = fakeHash({
        title: args.p_title,
        content: args.p_content,
        variants,
        presentation: args.p_presentation_id,
      });
      row = {
        locale: args.p_locale,
        title: args.p_title,
        description: args.p_description,
        content: structuredClone(args.p_content),
        question_variants: structuredClone(variants),
        seo: structuredClone(args.p_seo),
        sources: structuredClone(args.p_sources),
        content_hash: contentHash,
        reviewed_content_hash:
          args.p_reviewed_content_hash === contentHash ? contentHash : null,
        translation_qa: structuredClone(args.p_translation_qa),
        status: args.p_reviewed_content_hash === contentHash ? 'complete' : 'draft',
        draft_version: (row?.draft_version ?? 0) + 1,
      };
      course.draftLocalizations = course.draftLocalizations.filter(
        (item) => item.locale !== args.p_locale,
      );
      course.draftLocalizations.push(row);
      course.draftMappings = course.draftMappings.filter(
        (item) => item.locale !== args.p_locale,
      );
      course.draftMappings.push({
        locale: args.p_locale,
        presentation_id: args.p_presentation_id,
      });
      return { draftVersion: row.draft_version, contentHash };
    },
    async importCourseAssessment(args) {
      mutations.assessmentImports += 1;
      const course = courses.get(args.p_test_id);
      const row = course.draftLocalizations.find((item) => item.locale === args.p_locale);
      assert.equal(args.p_expected_version, row.draft_version);
      row.question_variants = structuredClone(args.p_question_variants);
      row.content_hash = fakeHash({
        title: row.title,
        content: row.content,
        variants: row.question_variants,
        presentation: course.draftMappings.find((item) => item.locale === args.p_locale)
          ?.presentation_id,
      });
      row.reviewed_content_hash = null;
      row.translation_qa = { ...row.translation_qa, assessmentImported: true };
      row.status = 'draft';
      row.draft_version += 1;
      return { draftVersion: row.draft_version, contentHash: row.content_hash };
    },
    async publishCourse(args) {
      mutations.coursePublishes += 1;
      const course = courses.get(args.p_test_id);
      assert.equal(args.p_expected_content_hash, course.draft.content_hash);
      course.test.content_version += 1;
      course.test.current_revision_id = REVISION_ID;
      const variants = [];
      const variantLocalizations = [];
      for (const row of course.draftLocalizations) {
        for (const localizedVariant of row.question_variants) {
          let variant = variants.find((item) => item.stable_id === localizedVariant.id);
          if (!variant) {
            variant = {
              id: `50000000-0000-4000-8000-${String(variants.length + 1).padStart(12, '0')}`,
              stable_id: localizedVariant.id,
              variant_number: localizedVariant.variantNumber,
              question_count: 10,
            };
            variants.push(variant);
          }
          variantLocalizations.push({
            variant_id: variant.id,
            locale: row.locale,
            questions: localizedVariant.questions.map(({ explanation: _unused, ...question }) =>
              structuredClone(question),
            ),
            explanations: localizedVariant.questions.map((question) => question.explanation),
          });
        }
      }
      course.current = {
        revisionId: REVISION_ID,
        localizations: course.draftLocalizations.map((row) => structuredClone(row)),
        variants,
        variantLocalizations,
        mappings: course.draftMappings.map((row) => structuredClone(row)),
      };
      return { revisionId: REVISION_ID, locales: ['ru', 'kk', 'en', 'zh'] };
    },
    async readArticle(slug) {
      return structuredClone(articles.get(slug));
    },
    async saveArticleLocalization(args) {
      mutations.articleSaves += 1;
      const state = [...articles.values()].find((item) => item.article.id === args.p_article_id);
      let row = state.draftLocalizations.find((item) => item.locale === args.p_locale);
      if (row) assert.equal(args.p_expected_version, row.draft_version);
      else assert.equal(args.p_expected_version, null);
      const contentHash = fakeHash({
        title: args.p_title,
        blocks: args.p_blocks,
        seo: args.p_seo,
      });
      row = {
        locale: args.p_locale,
        title: args.p_title,
        description: args.p_description,
        blocks: structuredClone(args.p_blocks),
        seo: structuredClone(args.p_seo),
        sources: structuredClone(args.p_sources),
        content_hash: contentHash,
        reviewed_content_hash:
          args.p_reviewed_content_hash === contentHash ? contentHash : null,
        translation_qa: structuredClone(args.p_translation_qa),
        status: args.p_reviewed_content_hash === contentHash ? 'complete' : 'draft',
        draft_version: (row?.draft_version ?? 0) + 1,
      };
      state.draftLocalizations = state.draftLocalizations.filter(
        (item) => item.locale !== args.p_locale,
      );
      state.draftLocalizations.push(row);
      return { draftVersion: row.draft_version, contentHash };
    },
    async publishArticle(args) {
      mutations.articlePublishes += 1;
      const state = [...articles.values()].find((item) => item.article.id === args.p_article_id);
      assert.equal(args.p_expected_content_hash, state.draft.content_hash);
      state.article.content_version += 1;
      state.article.current_revision_id = REVISION_ID;
      state.current = {
        revisionId: REVISION_ID,
        localizations: state.draftLocalizations.map((row) => structuredClone(row)),
      };
      return { revisionId: REVISION_ID, locales: ['ru', 'kk', 'en', 'zh'] };
    },
    async readLegal(documentType, version) {
      return structuredClone(
        legal.get(`${documentType}:${version}`) ?? { version: null, localizations: [] },
      );
    },
    async stageLegal(args) {
      mutations.legalStages += 1;
      legal.set(`${args.p_document_type}:${args.p_version}`, {
        version: {
          document_type: args.p_document_type,
          version: args.p_version,
          body_revision: args.p_body_revision,
          effective_at: new Date(args.p_effective_at).toISOString(),
          is_current: false,
        },
        localizations: [],
      });
      return { status: 'draft' };
    },
    async saveLegal(args) {
      mutations.legalSaves += 1;
      const state = legal.get(`${args.p_document_type}:${args.p_version}`);
      const row = {
        locale: args.p_locale,
        title: args.p_title,
        body: structuredClone(args.p_body),
        body_hash: fakeHash(args.p_body),
        status: args.p_complete ? 'complete' : 'draft',
      };
      state.localizations = state.localizations.filter((item) => item.locale !== args.p_locale);
      state.localizations.push(row);
      return { locale: row.locale, bodyHash: row.body_hash };
    },
    async publishLegal(args) {
      mutations.legalPublishes += 1;
      for (const [key, state] of legal) {
        if (key.startsWith(`${args.p_document_type}:`)) state.version.is_current = false;
      }
      const state = legal.get(`${args.p_document_type}:${args.p_version}`);
      state.version.is_current = true;
      for (const row of state.localizations) row.status = 'published';
      return { locales: ['ru', 'kk', 'en', 'zh'] };
    },
  };
}

test('Stage 6 plan is reviewed, bounded and answer-key free', async () => {
  const batch = await loadStage6PublicationBatch({ validateRelease: false });
  assert.equal(batch.counts.courseLocalizations, 15);
  assert.equal(batch.counts.presentations, 15);
  assert.equal(batch.counts.articleLocalizations, 30);
  assert.equal(batch.counts.currentLegalLocalizations, 8);
  assert.doesNotThrow(() => assertNoAnswerKeys(batch.courses.map((item) => item.assessment)));
  assert.throws(
    () => assertNoAnswerKeys({ correctOptionId: 'not-public' }),
    (error) =>
      error instanceof Stage6PublicationContractError &&
      error.message === 'STAGE6_ANSWER_KEY_FIELD_FORBIDDEN',
  );
});

test('apply requires the exact current project, reviewed hash and strong confirmation', async () => {
  const batch = await loadStage6PublicationBatch({ validateRelease: false });
  const argv = [
    '--apply',
    '--project-ref',
    CURRENT_PRODUCTION_PROJECT_REF,
    '--actor-id',
    ACTOR_ID,
    '--batch-hash',
    batch.batchHash,
    '--confirm',
    `STAGE6-PUBLISH:${CURRENT_PRODUCTION_PROJECT_REF}:${batch.batchHash}`,
  ];
  const parsed = parseCliArguments(argv, batch.batchHash);
  assert.equal(parsed.mode, 'apply');
  assert.equal(parsed.projectRef, CURRENT_PRODUCTION_PROJECT_REF);
  assert.throws(
    () => parseCliArguments([...argv.slice(0, -1), 'wrong'], batch.batchHash),
    /STAGE6_CONFIRMATION_INVALID/u,
  );
  assert.throws(
    () =>
      parseCliArguments(
        argv.map((value) => (value === batch.batchHash ? 'f'.repeat(64) : value)),
        batch.batchHash,
      ),
    /STAGE6_BATCH_HASH_NOT_REVIEWED/u,
  );
});

test('publication derives draft versions, resumes from hosted state and emits only hashes/counts', async () => {
  const batch = await loadStage6PublicationBatch({ validateRelease: false });
  const repository = createFakeRepository(batch);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-stage6-publication-'));
  try {
    const baseOptions = {
      mode: 'apply',
      projectRef: CURRENT_PRODUCTION_PROJECT_REF,
      actorId: ACTOR_ID,
      batchHash: batch.batchHash,
      confirmation: `STAGE6-PUBLISH:${CURRENT_PRODUCTION_PROJECT_REF}:${batch.batchHash}`,
    };
    const first = await executeStage6Publication({
      options: { ...baseOptions, receiptPath: path.join(directory, 'first.json') },
      root: process.cwd(),
      repository,
      skipLinkedProjectCheck: true,
      validateRelease: false,
    });
    assert.equal(first.receipt.status, 'completed');
    assert.equal(first.receipt.answerKeysIncluded, false);
    assert.equal(first.receipt.operationalPiiIncluded, false);
    assert.equal(repository.mutations.coursePublishes, 5);
    assert.equal(repository.mutations.articlePublishes, 10);
    assert.equal(repository.mutations.legalStages, 2);
    const afterFirst = structuredClone(repository.mutations);

    const second = await executeStage6Publication({
      options: { ...baseOptions, receiptPath: path.join(directory, 'second.json') },
      root: process.cwd(),
      repository,
      skipLinkedProjectCheck: true,
      validateRelease: false,
    });
    assert.deepEqual(repository.mutations, afterFirst);
    assert.deepEqual(second.receipt.hashes, first.receipt.hashes);
    assert.equal(second.receipt.counts.reusedCourseRevisions, 5);
    assert.equal(second.receipt.counts.reusedArticleRevisions, 10);

    const samePathReplay = await executeStage6Publication({
      options: { ...baseOptions, receiptPath: path.join(directory, 'first.json') },
      root: process.cwd(),
      repository,
      skipLinkedProjectCheck: true,
      validateRelease: false,
    });
    assert.deepEqual(samePathReplay.receipt, first.receipt);
    assert.deepEqual(repository.mutations, afterFirst);

    const serialized = await readFile(path.join(directory, 'second.json'), 'utf8');
    assert.doesNotMatch(
      serialized,
      /"(?:correctOption(?:Id|Ids)?|answerKey(?:s)?)"\s*:|"title"|"description"|actorId/iu,
    );
    assert.doesNotMatch(serialized, /11111111-1111-4111-8111-111111111111/u);
    assert.ok(stable(second.receipt.hashes).length > 100);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
