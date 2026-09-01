/**
 * Aggregates the fail-closed, pre-export typography audit for selected
 * localized SafetyHub presentation candidates. The output has no timestamp so
 * identical text maps and rendered layouts produce byte-identical JSON.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const localeArgument = process.argv.find((value) => value.startsWith('--locales='))?.slice('--locales='.length) ?? 'kk,en';
const locales = localeArgument === 'all'
  ? ['kk', 'en', 'zh']
  : localeArgument.split(',').map((value) => value.trim()).filter(Boolean);
if (!locales.length || locales.some((locale) => !['kk', 'en', 'zh'].includes(locale))) {
  throw new Error(`LAYOUT_AGGREGATE_LOCALES_INVALID:${localeArgument}`);
}
const slugs = [
  'plotnik',
  'armaturshchik',
  'lesomontazhnye-raboty',
  'biot',
  'pozharnaya-bezopasnost',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function relativeToRepo(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

const decks = [];
const regressions = [];
for (const locale of locales) {
  for (const slug of slugs) {
    const reportPath = path.join(workspaceRoot, locale, slug, 'qa', 'layout-regressions.json');
    const mapPath = path.join(stagedRoot, 'presentations', slug, locale, 'text-map.json');
    const [reportText, mapBytes] = await Promise.all([
      fs.readFile(reportPath, 'utf8'),
      fs.readFile(mapPath),
    ]);
    const report = JSON.parse(reportText);
    const currentMapSha256 = sha256(mapBytes);
    if (report.locale !== locale || report.slug !== slug) {
      throw new Error(`LAYOUT_REPORT_IDENTITY_MISMATCH:${locale}:${slug}`);
    }
    if (report.textMapSha256 !== currentMapSha256) {
      throw new Error(`LAYOUT_REPORT_STALE:${locale}:${slug}:${report.textMapSha256}:${currentMapSha256}`);
    }
    if (report.sourceSlideCount !== report.inspectedSlideCount) {
      throw new Error(`LAYOUT_REPORT_SLIDE_COUNT_MISMATCH:${locale}:${slug}`);
    }
    if (report.regressionCount !== report.regressions.length) {
      throw new Error(`LAYOUT_REPORT_REGRESSION_COUNT_MISMATCH:${locale}:${slug}`);
    }
    decks.push({
      locale,
      slug,
      textMapSha256: currentMapSha256,
      slideCount: report.sourceSlideCount,
      inspectedSlideCount: report.inspectedSlideCount,
      regressionCount: report.regressionCount,
      report: relativeToRepo(reportPath),
    });
    regressions.push(...report.regressions);
  }
}

const byCode = {};
for (const regression of regressions) {
  for (const code of regression.codes) byCode[code] = (byCode[code] ?? 0) + 1;
}
const output = {
  schemaVersion: 1,
  scope: {
    locales,
    slugs,
    deckLocaleCount: decks.length,
    sourceSlideCount: decks.reduce((total, deck) => total + deck.slideCount, 0),
    inspectedSlideCount: decks.reduce((total, deck) => total + deck.inspectedSlideCount, 0),
  },
  state: 'PRE_FREEZE_LAYOUT_AUDIT',
  releaseGate: 'FAIL_CLOSED_UNTIL_ZERO_REGRESSIONS_AND_TEXT_MAPS_FROZEN',
  rules: {
    fontShrinkTolerancePx: 0.5,
    oneLineTitleMustRemainOneLine: true,
  },
  regressionCount: regressions.length,
  regressionCountByCode: Object.fromEntries(Object.entries(byCode).sort(([left], [right]) => left.localeCompare(right))),
  decks,
  regressions,
};

const localeSuffix = locales.join('-') === 'kk-en-zh' ? 'all' : locales.join('-');
const outputPath = path.join(workspaceRoot, 'qa', `layout-regressions.${localeSuffix}.json`);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  ok: true,
  output: relativeToRepo(outputPath),
  deckLocaleCount: decks.length,
  slideCount: output.scope.inspectedSlideCount,
  regressionCount: regressions.length,
  regressionCountByCode: output.regressionCountByCode,
}));
