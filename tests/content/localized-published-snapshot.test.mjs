import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildLocalizedPublishedSnapshot,
  LocalizedSnapshotError,
  validateLocalizedPublishedSnapshot,
} from '../../scripts/content-localization/localized-published-snapshot.mjs';
import {
  canonicalHash,
  loadStage6PublicationBatch,
  sha256,
  STAGE6_ALL_LOCALES,
} from '../../scripts/content-localization/stage6-publication-contract.mjs';

function uuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

async function json(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function publicQuestions(questions) {
  return questions.map(({ id, text, options }, questionIndex) => ({
    id,
    text,
    displayOrder: questionIndex + 1,
    options: options.map(({ id: optionId, text: optionText }, optionIndex) => ({
      id: optionId,
      text: optionText,
      displayOrder: optionIndex + 1,
    })),
  }));
}

async function fixture() {
  const root = process.cwd();
  const batch = await loadStage6PublicationBatch({ root, validateRelease: false });
  const catalog = await json(path.join(root, 'content', 'snapshots', 'courses', 'catalog.json'));
  const courseLocalizationRows = [];
  const variantLocalizationRows = [];
  const presentationAssets = new Map();
  for (const catalogCourse of catalog.courses) {
    const source = await json(
      path.join(root, 'content', 'snapshots', 'courses', catalogCourse.slug, 'course.json'),
    );
    const sourceThumbnail = await readFile(
      path.join(root, 'content', 'snapshots', 'courses', catalogCourse.slug, 'thumbnail.webp'),
    );
    const revisionId = uuid(`revision:${source.slug}`);
    const ruRow = {
      course_id: source.id,
      revision_id: revisionId,
      slug: source.slug,
      locale: 'ru',
      title: source.title,
      description: source.description,
      content: { modules: [] },
      seo: source.seo,
      sources: source.sources,
      localization_content_hash: source.dbContentHash,
      presentation_id: source.presentation.id,
      presentation_locale: 'ru',
      storage_bucket: source.presentation.storageBucket,
      storage_path: source.presentation.storagePath,
      thumbnail_path: source.presentation.thumbnailPath,
      source_filename: source.presentation.sourceFilename,
      mime_type: source.presentation.mimeType,
      presentation_byte_size: source.presentation.byteSize,
      presentation_sha256: source.presentation.sha256,
      presentation_page_count: source.presentation.pageCount,
      aspect_ratio: source.presentation.aspectRatio,
      presentation_status: 'ready',
    };
    courseLocalizationRows.push(ruRow);
    for (const variant of source.variants) {
      const questions = publicQuestions(variant.questions);
      const explanations = variant.questions.map((question) => question.explanation ?? '');
      variantLocalizationRows.push({
        revision_id: revisionId,
        slug: source.slug,
        stable_id: variant.id,
        variant_number: variant.variantNumber,
        locale: 'ru',
        questions,
        explanations,
        question_count: 10,
        structure_hash: digest({ ids: questions.map((question) => question.id) }),
        variant_content_hash: digest({ questions, explanations }),
      });
    }
    for (const locale of ['kk', 'en', 'zh']) {
      const entry = batch.courses.find(
        (item) => item.slug === source.slug && item.locale === locale,
      );
      const presentationId = uuid(`presentation:${source.slug}:${locale}`);
      const prefix = `${source.id}/${locale}/${presentationId}`;
      courseLocalizationRows.push({
        course_id: source.id,
        revision_id: revisionId,
        slug: source.slug,
        locale,
        title: entry.draft.title,
        description: entry.draft.description,
        content: entry.draft.content,
        seo: entry.draft.seo,
        sources: entry.draft.sources,
        localization_content_hash: digest({ course: source.slug, locale }),
        presentation_id: presentationId,
        presentation_locale: locale,
        storage_bucket: 'course-presentations',
        storage_path: `${prefix}/${entry.presentation.sha256}.pdf`,
        thumbnail_path: `${prefix}/${entry.presentation.sha256}-thumb.webp`,
        source_filename: entry.presentation.sourceFilename,
        mime_type: 'application/pdf',
        presentation_byte_size: entry.presentation.byteSize,
        presentation_sha256: entry.presentation.sha256,
        presentation_page_count: entry.presentation.pageCount,
        aspect_ratio: '16:9',
        presentation_status: 'ready',
      });
      presentationAssets.set(presentationId, {
        pdf: entry.presentation.pdf.bytes,
        thumbnail: sourceThumbnail,
      });
      for (const variant of entry.assessment.questionVariants) {
        const questions = publicQuestions(variant.questions);
        const explanations = variant.questions.map((question) => question.explanation);
        variantLocalizationRows.push({
          revision_id: revisionId,
          slug: source.slug,
          stable_id: variant.id,
          variant_number: variant.variantNumber,
          locale,
          questions,
          explanations,
          question_count: 10,
          structure_hash: digest({ ids: questions.map((question) => question.id) }),
          variant_content_hash: digest({ questions, explanations }),
        });
      }
    }
  }

  const articleLocalizationRows = [];
  const articleSlugs = [...new Set(batch.articles.map((item) => item.slug))];
  for (const slug of articleSlugs) {
    const source = await json(path.join(root, 'content', 'articles', `${slug}.json`));
    const articleId = uuid(`article:${slug}`);
    const revisionId = uuid(`article-revision:${slug}`);
    articleLocalizationRows.push({
      article_id: articleId,
      revision_id: revisionId,
      slug,
      locale: 'ru',
      title: source.title,
      description: source.description,
      blocks: source.blocks,
      seo: source.seo,
      sources: source.sources,
      localization_content_hash: digest({ slug, locale: 'ru' }),
    });
    for (const locale of ['kk', 'en', 'zh']) {
      const document = batch.articles.find(
        (item) => item.slug === slug && item.locale === locale,
      ).document;
      articleLocalizationRows.push({
        article_id: articleId,
        revision_id: revisionId,
        slug,
        locale,
        title: document.title,
        description: document.description,
        blocks: document.blocks,
        seo: document.seo,
        sources: document.sources,
        localization_content_hash: digest({ slug, locale }),
      });
    }
  }

  const legalVersionRows = [];
  const legalLocalizationRows = [];
  for (const document of batch.legal) {
    legalVersionRows.push(
      {
        document_type: document.documentType,
        version: document.historicalVersion,
        body_revision: `${document.documentType}-${document.historicalVersion}`,
        effective_at: new Date('2026-08-31T00:00:00.000Z'),
        is_current: false,
      },
      {
        document_type: document.documentType,
        version: document.version,
        body_revision: document.stageArgs.p_body_revision,
        effective_at: new Date(document.stageArgs.p_effective_at),
        is_current: true,
      },
    );
    const historicalRuBody = {
      bodyRevision: `${document.documentType}-${document.historicalVersion}`,
    };
    legalLocalizationRows.push({
      document_type: document.documentType,
      version: document.historicalVersion,
      locale: 'ru',
      title: 'RU historical copy',
      body: historicalRuBody,
      body_hash: digest(historicalRuBody),
      status: 'published',
    });
    for (const item of document.historical) {
      legalLocalizationRows.push({
        document_type: document.documentType,
        version: document.historicalVersion,
        locale: item.locale,
        title: item.title,
        body: item.body,
        body_hash: digest(item.body),
        status: 'published',
      });
    }
    for (const item of document.localizations) {
      legalLocalizationRows.push({
        document_type: document.documentType,
        version: document.version,
        locale: item.locale,
        title: item.args.p_title,
        body: item.args.p_body,
        body_hash: digest(item.args.p_body),
        status: 'published',
      });
    }
  }
  return {
    batch,
    courseLocalizationRows,
    variantLocalizationRows,
    articleLocalizationRows,
    legalVersionRows,
    legalLocalizationRows,
    presentationAssets,
  };
}

test('published localization snapshot is complete, immutable and contains no answer key', async () => {
  const input = await fixture();
  const built = buildLocalizedPublishedSnapshot(input);
  assert.equal(built.manifest.counts.courseLocalizationCount, 20);
  assert.equal(built.manifest.counts.variantLocalizationCount, 60);
  assert.equal(built.manifest.counts.articleLocalizationCount, 40);
  assert.equal(built.manifest.counts.legalLocalizationCount, 16);
  assert.equal(built.manifest.counts.localizedPresentationAssetCount, 15);
  assert.equal(built.files.size, 31);
  assert.doesNotMatch(
    JSON.stringify(built.manifest),
    /"(?:correctOption(?:Id|Ids)?|answerKey(?:s)?)"\s*:/iu,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-localized-snapshot-'));
  try {
    for (const [relativePath, bytes] of built.files) {
      const output = path.join(directory, ...relativePath.split('/'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    const validation = await validateLocalizedPublishedSnapshot({
      root: process.cwd(),
      snapshotRoot: directory,
      required: true,
    });
    assert.equal(validation.present, true);
    assert.equal(validation.manifestHash, built.manifest.manifestHash);

    const mutatedManifest = structuredClone(built.manifest);
    const targetLocalization = mutatedManifest.courses
      .flatMap((course) => course.localizations)
      .find((localization) => localization.locale === 'en');
    targetLocalization.title = `${targetLocalization.title} drift`;
    const { manifestHash: _priorManifestHash, ...mutatedProjection } = mutatedManifest;
    mutatedManifest.manifestHash = canonicalHash(mutatedProjection);
    await writeFile(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(mutatedManifest, null, 2)}\n`,
    );
    await assert.rejects(
      validateLocalizedPublishedSnapshot({
        root: process.cwd(),
        snapshotRoot: directory,
        required: true,
      }),
      (error) =>
        error instanceof LocalizedSnapshotError &&
        error.message === 'LOCALIZED_SNAPSHOT_COURSE_DRIFT',
    );
    await writeFile(path.join(directory, 'manifest.json'), built.files.get('manifest.json'));

    const firstAsset = built.manifest.courses
      .flatMap((course) => course.localizations)
      .find((localization) => localization.locale !== 'ru').presentation.asset.pdfFile;
    await writeFile(path.join(directory, ...firstAsset.split('/')), Buffer.from('%PDF-tampered'));
    await assert.rejects(
      validateLocalizedPublishedSnapshot({
        root: process.cwd(),
        snapshotRoot: directory,
        required: true,
      }),
      (error) =>
        error instanceof LocalizedSnapshotError &&
        error.message === 'LOCALIZED_SNAPSHOT_ASSET_HASH_INVALID',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every localized course, article and variant has exactly RU/KK/EN/ZH', async () => {
  const built = buildLocalizedPublishedSnapshot(await fixture());
  for (const course of built.manifest.courses) {
    assert.deepEqual(
      course.localizations.map((item) => item.locale).sort(),
      [...STAGE6_ALL_LOCALES].sort(),
    );
    for (const variant of course.variants) {
      assert.deepEqual(
        variant.localizations.map((item) => item.locale).sort(),
        [...STAGE6_ALL_LOCALES].sort(),
      );
    }
  }
  for (const article of built.manifest.articles) {
    assert.deepEqual(
      article.localizations.map((item) => item.locale).sort(),
      [...STAGE6_ALL_LOCALES].sort(),
    );
  }
});

test('a later complete legal revision may become current without mutating the Stage 6 receipt', async () => {
  const input = await fixture();
  const newVersions = [
    { documentType: 'privacy', version: '1.4', bodyRevision: 'privacy-1.4' },
    { documentType: 'terms', version: '2.4', bodyRevision: 'terms-2.4' },
  ];

  for (const next of newVersions) {
    const prior = input.legalVersionRows.find(
      (row) => row.document_type === next.documentType && row.is_current,
    );
    prior.is_current = false;
    input.legalVersionRows.push({
      document_type: next.documentType,
      version: next.version,
      body_revision: next.bodyRevision,
      effective_at: new Date('2026-09-02T00:00:00.000Z'),
      is_current: true,
    });
    for (const locale of STAGE6_ALL_LOCALES) {
      const source = await json(
        path.join(
          process.cwd(),
          'content',
          'legal',
          next.documentType,
          `${next.version}.${locale}.json`,
        ),
      );
      input.legalLocalizationRows.push({
        document_type: next.documentType,
        version: next.version,
        locale,
        title: source.title,
        body: source.body,
        body_hash: digest(source.body),
        status: 'published',
      });
    }
  }

  const built = buildLocalizedPublishedSnapshot(input);
  assert.equal(built.manifest.counts.legalLocalizationCount, 24);
  assert.equal(
    built.manifest.legalVersions.find((item) => item.documentType === 'privacy' && item.isCurrent)
      .version,
    '1.4',
  );
  assert.equal(
    built.manifest.legalVersions.find((item) => item.documentType === 'terms' && item.isCurrent)
      .version,
    '2.4',
  );
});

test('source-controlled legal revisions fail closed when a published copy drifts', async () => {
  const input = await fixture();
  for (const next of [
    { documentType: 'privacy', version: '1.4', bodyRevision: 'privacy-1.4' },
    { documentType: 'terms', version: '2.4', bodyRevision: 'terms-2.4' },
  ]) {
    const prior = input.legalVersionRows.find(
      (row) => row.document_type === next.documentType && row.is_current,
    );
    prior.is_current = false;
    input.legalVersionRows.push({
      document_type: next.documentType,
      version: next.version,
      body_revision: next.bodyRevision,
      effective_at: new Date('2026-09-02T00:00:00.000Z'),
      is_current: true,
    });
    for (const locale of STAGE6_ALL_LOCALES) {
      const source = await json(
        path.join(
          process.cwd(),
          'content',
          'legal',
          next.documentType,
          `${next.version}.${locale}.json`,
        ),
      );
      input.legalLocalizationRows.push({
        document_type: next.documentType,
        version: next.version,
        locale,
        title: source.title,
        body: source.body,
        body_hash: digest(source.body),
        status: 'published',
      });
    }
  }
  const target = input.legalLocalizationRows.find(
    (row) => row.document_type === 'terms' && row.version === '2.4' && row.locale === 'zh',
  );
  target.body = { ...target.body, unexpected: true };
  target.body_hash = digest(target.body);

  assert.throws(
    () => buildLocalizedPublishedSnapshot(input),
    (error) =>
      error instanceof LocalizedSnapshotError &&
      error.message === 'LOCALIZED_SNAPSHOT_SOURCE_LEGAL_DRIFT',
  );
});

test('content seed deterministically includes the complete published localization snapshot', async () => {
  const built = buildLocalizedPublishedSnapshot(await fixture());
  const directory = await mkdtemp(path.join(os.tmpdir(), 'safetyhub-localized-seed-'));
  const snapshotRoot = path.join(directory, 'snapshot');
  const firstOutput = path.join(directory, 'seed-first.sql');
  const secondOutput = path.join(directory, 'seed-second.sql');
  try {
    for (const [relativePath, bytes] of built.files) {
      const output = path.join(snapshotRoot, ...relativePath.split('/'));
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, bytes);
    }
    for (const output of [firstOutput, secondOutput]) {
      const generated = spawnSync(
        process.execPath,
        [
          'scripts/generate-content-seed.mjs',
          '--localizations-root',
          snapshotRoot,
          '--output',
          output,
        ],
        { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(generated.status, 0, generated.stderr || generated.stdout);
    }
    const [first, second] = await Promise.all([
      readFile(firstOutput, 'utf8'),
      readFile(secondOutput, 'utf8'),
    ]);
    assert.equal(first, second);
    assert.match(first, /insert into public\.test_revision_variant_localizations/iu);
    assert.match(first, /insert into public\.article_revision_localizations/iu);
    assert.match(first, /insert into public\.legal_document_localizations/iu);
    assert.match(first, /insert into public\.course_draft_presentations/iu);
    assert.match(first, /staged-2026-09-01/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
