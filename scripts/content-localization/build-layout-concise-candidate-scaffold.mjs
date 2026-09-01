/**
 * Builds a deterministic reviewer scaffold from the current fail-closed KK/EN
 * presentation typography report. It never edits translation maps or shared
 * overrides; candidates are review input only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const reportPath = path.join(workspaceRoot, 'qa', 'layout-regressions.kk-en.json');
const outputPath = path.join(workspaceRoot, 'qa', 'layout-concise-candidates.kk-en.json');

function key(locale, sourceSha, current) {
  return `${locale}\u0000${sourceSha}\u0000${current}`;
}

const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
const maps = new Map();
for (const deck of report.decks) {
  const mapPath = path.join(stagedRoot, 'presentations', deck.slug, deck.locale, 'text-map.json');
  maps.set(`${deck.locale}:${deck.slug}`, JSON.parse(await fs.readFile(mapPath, 'utf8')));
}

const grouped = new Map();
for (const regression of report.regressions) {
  const map = maps.get(`${regression.locale}:${regression.slug}`);
  const slide = map?.slides.find((candidate) => candidate.slide === regression.slide);
  const element = slide?.elements.find((candidate) => String(candidate.shapeId) === String(regression.shapeId));
  if (!element || element.translatedText !== regression.translatedText || element.text !== regression.sourceText) {
    throw new Error(`REGRESSION_MAP_JOIN_FAILED:${regression.locale}:${regression.slug}:${regression.slide}:${regression.shapeId}`);
  }
  const groupKey = key(regression.locale, element.sourceTextSha256, element.translatedText);
  let candidate = grouped.get(groupKey);
  if (!candidate) {
    candidate = {
      sourceSha: element.sourceTextSha256,
      locale: regression.locale,
      source: element.text,
      current: element.translatedText,
      candidate: null,
      backTranslation: element.text,
      rationale: null,
      constraints: {
        preserveNegation: true,
        preserveActor: true,
        preserveCondition: true,
        preserveNumbers: true,
        preserveTerminology: true,
        englishHeadingTitleCase: regression.locale === 'en',
        targetNoWiderThanRussianSource: true,
      },
      contexts: [],
    };
    grouped.set(groupKey, candidate);
  }
  candidate.contexts.push({
    slug: regression.slug,
    slide: regression.slide,
    shapeId: regression.shapeId,
    name: regression.name,
    codes: regression.codes,
    sourceFontSize: regression.sourceFontSize,
    finalFontSize: regression.finalFontSize,
    sourceLineCount: regression.sourceLineCount,
    finalLineCount: regression.finalLineCount,
    availableBox: regression.availableBox,
  });
}

const localeOrder = new Map([['kk', 0], ['en', 1]]);
const slugOrder = new Map(report.scope.slugs.map((slug, index) => [slug, index]));
const candidates = [...grouped.values()].sort((left, right) => {
  const localeDifference = localeOrder.get(left.locale) - localeOrder.get(right.locale);
  if (localeDifference) return localeDifference;
  const leftContext = left.contexts[0];
  const rightContext = right.contexts[0];
  const slugDifference = slugOrder.get(leftContext.slug) - slugOrder.get(rightContext.slug);
  if (slugDifference) return slugDifference;
  if (leftContext.slide !== rightContext.slide) return leftContext.slide - rightContext.slide;
  return String(leftContext.shapeId).localeCompare(String(rightContext.shapeId), 'en', { numeric: true });
});

const output = {
  schemaVersion: 1,
  state: 'POST_BATCH_1_REVIEW_CANDIDATES',
  sharedOverridesModified: false,
  sourceReport: 'tmp/stage6/presentation-localization/qa/layout-regressions.kk-en.json',
  sourceReportRegressionCount: report.regressionCount,
  sourceMapHashes: report.decks.map(({ locale, slug, textMapSha256 }) => ({ locale, slug, textMapSha256 })),
  candidateCount: candidates.length,
  candidates,
};
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, output: path.relative(repoRoot, outputPath).replaceAll('\\', '/'), candidateCount: candidates.length }));
