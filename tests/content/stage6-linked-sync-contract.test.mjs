import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

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
