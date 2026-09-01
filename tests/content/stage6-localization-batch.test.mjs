import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the staged KK/EN/ZH content batch preserves topology and security boundaries', () => {
  const script = path.resolve('scripts/content-localization/validate-stage6-localizations.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.deepEqual(receipt.locales, ['kk', 'en', 'zh']);
  assert.deepEqual(
    {
      courses: receipt.courses,
      variants: receipt.variants,
      questions: receipt.questions,
      options: receipt.options,
      articles: receipt.articles,
      historicalLegalDocuments: receipt.historicalLegalDocuments,
      currentLegalDocuments: receipt.currentLegalDocuments,
      currentLegalLocalizations: receipt.currentLegalLocalizations,
      presentationDecks: receipt.presentationDecks,
      localizedSlides: receipt.localizedSlides,
    },
    {
      courses: 5,
      variants: 15,
      questions: 150,
      options: 600,
      articles: 10,
      historicalLegalDocuments: 2,
      currentLegalDocuments: 2,
      currentLegalLocalizations: 8,
      presentationDecks: 5,
      localizedSlides: 594,
    },
  );
});
