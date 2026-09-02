import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadStage6PublicationBatch } from '../../scripts/content-localization/stage6-publication-contract.mjs';

const root = process.cwd();

test('linked pull includes the complete four-locale published content contract', async () => {
  const source = await readFile(`${root}/scripts/content-sync-linked.mjs`, 'utf8');
  const queryStart = source.indexOf('courseLocalizationRows =');
  const queryEnd = source.indexOf("await client.query('commit')", queryStart);
  assert.ok(queryStart > 0 && queryEnd > queryStart, 'localized repeatable-read query block missing');
  const queryBlock = source.slice(queryStart, queryEnd);

  for (const relation of [
    'test_revision_localizations',
    'test_revision_presentations',
    'test_revision_variant_localizations',
    'article_revision_localizations',
    'legal_document_versions',
    'legal_document_localizations',
  ]) {
    assert.match(queryBlock, new RegExp(`public\\.${relation}`, 'u'));
  }
  assert.doesNotMatch(
    queryBlock,
    /correct_option|answer_key|auth\.users|profiles|attempts|certificates|acceptances|sessions|identities|audit/iu,
  );
  assert.match(source, /targetPresentationRows\.length !== 15/u);
  assert.match(source, /buildLocalizedPublishedSnapshot\(\{/u);
  assert.match(source, /localizedSnapshot\.files/u);
  assert.match(source, /validateLocalizedPublishedSnapshot\(\{/u);
  assert.match(source, /--localizations-root/u);
  assert.match(source, /staleLocalizedFiles/u);
});

test('package commands expose plan/apply and snapshot validation separately', async () => {
  const packageJson = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
  assert.equal(
    packageJson.scripts['content:localizations:publish:plan'],
    'node scripts/publish-stage6-localizations.mjs --plan',
  );
  assert.match(
    packageJson.scripts['content:localizations:publish'],
    /publish-stage6-localizations\.mjs --apply/u,
  );
  assert.match(
    packageJson.scripts['content:snapshot:validate'],
    /validate-published-localization-snapshot\.mjs --if-present/u,
  );
});

test('localized seed projection is fail-closed and contains no private answer mapping', async () => {
  const source = await readFile(`${root}/scripts/generate-content-seed.mjs`, 'utf8');
  const start = source.indexOf('const localizedSeedPayload =');
  const end = source.indexOf('const sql =', start);
  assert.ok(start > 0 && end > start, 'localized seed block missing');
  const localizedBlock = source.slice(start, end);
  assert.doesNotMatch(localizedBlock, /correct_option|answer_key/iu);
  for (const guard of [
    'LOCALIZED_COURSE_SEED_HASH_MISMATCH',
    'LOCALIZED_VARIANT_SEED_HASH_MISMATCH',
    'LOCALIZED_ARTICLE_SEED_HASH_MISMATCH',
    'LOCALIZED_LEGAL_LOCALIZATION_SEED_CONFLICT',
  ]) {
    assert.match(localizedBlock, new RegExp(guard, 'u'));
  }
});

test('localized course seed hashes use raw staged variants and isolate variant receipts', async () => {
  const [source, seed, snapshot] = await Promise.all([
    readFile(`${root}/scripts/generate-content-seed.mjs`, 'utf8'),
    readFile(`${root}/supabase/seed.sql`, 'utf8'),
    readFile(`${root}/content/snapshots/localizations/manifest.json`, 'utf8'),
  ]);
  const payloadMatches = [
    ...seed.matchAll(/v_payload jsonb := \$localized\$(.*?)\$localized\$::jsonb;/gsu),
  ];
  const payload = payloadMatches
    .map((match) => JSON.parse(match[1]))
    .find((candidate) => Array.isArray(candidate?.courses));
  assert.ok(payload, 'localized course seed payload missing');

  // The hash guard uses exactly the raw staged variants. Variant-level
  // receipts are deliberately outside that input and are consumed only for
  // test_revision_variant_localizations below.
  assert.match(source, /variants: variants\.map\(\(\{ stagedVariant \}\) => stagedVariant\)/u);
  assert.match(source, /variantReceipts: variants\.map\(\(\{ receipt \}\) => receipt\)/u);
  assert.match(source, /v_question_variants := v_localization -> 'variants';/u);
  assert.match(
    source,
    /private\.localized_course_content_hash\([\s\S]*?v_question_variants,[\s\S]*?v_localization -> 'presentation' ->> 'sha256'/u,
  );
  assert.match(source, /v_variant_receipt ->> 'structureHash'/u);
  assert.match(source, /v_variant_receipt ->> 'contentHash'/u);

  const batch = await loadStage6PublicationBatch({ root, validateRelease: false });
  const published = JSON.parse(snapshot);
  for (const entry of batch.courses) {
    const seededCourse = payload.courses.find((course) => course.slug === entry.slug);
    const seededLocalization = seededCourse?.localizations.find(
      (localization) => localization.locale === entry.locale,
    );
    const publishedLocalization = published.courses
      .find((course) => course.slug === entry.slug)
      ?.localizations.find((localization) => localization.locale === entry.locale);

    assert.ok(seededLocalization, `${entry.slug}/${entry.locale}: localized seed row missing`);
    assert.ok(publishedLocalization, `${entry.slug}/${entry.locale}: published receipt missing`);
    assert.equal(
      seededLocalization.contentHash,
      publishedLocalization.contentHash,
      `${entry.slug}/${entry.locale}: raw staged projection must retain published course receipt`,
    );
    assert.deepEqual(
      seededLocalization.variants,
      entry.assessment.questionVariants,
      `${entry.slug}/${entry.locale}: seed hash input must be the raw staged variants`,
    );
    assert.equal(seededLocalization.variantReceipts.length, seededLocalization.variants.length);

    for (const variant of seededLocalization.variants) {
      assert.equal(Object.hasOwn(variant, 'structureHash'), false);
      assert.equal(Object.hasOwn(variant, 'contentHash'), false);
      const receipt = seededLocalization.variantReceipts.find(
        (item) => item.id === variant.id && item.variantNumber === variant.variantNumber,
      );
      assert.match(receipt?.structureHash ?? '', /^[0-9a-f]{64}$/u);
      assert.match(receipt?.contentHash ?? '', /^[0-9a-f]{64}$/u);
    }
  }
});
