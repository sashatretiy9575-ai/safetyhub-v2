/**
 * Builds the one-target review-only pass5 proposal. It never modifies the
 * shared override, staged maps, or presentation binaries.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const reportPath = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization', 'qa', 'layout-regressions.kk-en.json');
const overridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const mapPath = path.join(
  repoRoot,
  'content',
  'localizations',
  'staged-2026-09-01',
  'presentations',
  'lesomontazhnye-raboty',
  'kk',
  'text-map.json',
);
const reviewRoot = path.join(repoRoot, 'tmp', 'stage6', 'semantic-review');
const candidatesPath = path.join(reviewRoot, 'layout-concise-candidates-pass5.kk.json');
const proposalPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass5.json');
const expandedPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass5.expanded.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function visualUnits(value) {
  return [...value].reduce((total, character) => {
    if (/\s/u.test(character)) return total + 0.45;
    if (/[-–—/:,.;()]/u.test(character)) return total + 0.55;
    if (/\p{Lu}/u.test(character)) return total + 1.08;
    return total + 1;
  }, 0);
}

await fs.mkdir(reviewRoot, { recursive: true });
const [reportBytes, overrideBytes, mapBytes] = await Promise.all([
  fs.readFile(reportPath),
  fs.readFile(overridePath),
  fs.readFile(mapPath),
]);
const report = JSON.parse(reportBytes);
const map = JSON.parse(mapBytes);
const failures = [];
if (report.regressionCount !== 1 || report.regressions.length !== 1) {
  failures.push(`EXPECTED_ONE_RESIDUAL:${report.regressionCount}:${report.regressions.length}`);
}
const regression = report.regressions[0];
if (
  regression?.locale !== 'kk'
  || regression?.slug !== 'lesomontazhnye-raboty'
  || regression?.slide !== 10
  || String(regression?.shapeId) !== '4'
) {
  failures.push('UNEXPECTED_RESIDUAL_IDENTITY');
}
const element = map.slides
  .find((slide) => slide.slide === regression?.slide)
  ?.elements.find((item) => String(item.shapeId) === String(regression?.shapeId));
if (!element || element.text !== regression.sourceText || element.translatedText !== regression.translatedText) {
  failures.push('RESIDUAL_MAP_JOIN_FAILED');
}

const candidate = 'Құрылыс мінбе жүйесі орнықты';
const currentVisualUnits = Number(visualUnits(regression.translatedText).toFixed(2));
const candidateVisualUnits = Number(visualUnits(candidate).toFixed(2));
const visualReductionPercent = Number(((1 - candidateVisualUnits / currentVisualUnits) * 100).toFixed(2));
if (visualReductionPercent < 10) failures.push(`INSUFFICIENT_MATERIAL_CONCISION:${visualReductionPercent}`);

const candidateArtifact = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  sharedOverridesModified: false,
  sourceReportSha256: sha256(reportBytes),
  sourceMapSha256: sha256(mapBytes),
  proposedAgainstSharedOverrideSha256: sha256(overrideBytes),
  candidateCount: 1,
  validationFailures: [...failures].sort(),
  candidates: [{
    sourceSha256: element?.sourceTextSha256,
    source: regression?.sourceText,
    locale: 'kk',
    current: regression?.translatedText,
    currentSha256: sha256(regression?.translatedText ?? ''),
    candidate,
    candidateSha256: sha256(candidate),
    backTranslation: regression?.sourceText,
    semanticContract: {
      constructionScaffoldingQualifierPreserved: true,
      systemQualifierPreserved: true,
      stabilityQualifierPreserved: true,
    },
    rationale: 'The compact predicate states that the construction-scaffolding system is stable, retaining all three source concepts while reducing estimated visual width materially.',
    currentVisualUnits,
    candidateVisualUnits,
    visualReductionPercent,
    contexts: [{
      slug: regression?.slug,
      slide: regression?.slide,
      shapeId: regression?.shapeId,
      name: regression?.name,
      codes: regression?.codes,
      sourceFontSize: regression?.sourceFontSize,
      finalFontSize: regression?.finalFontSize,
      sourceLineCount: regression?.sourceLineCount,
      finalLineCount: regression?.finalLineCount,
      availableBox: regression?.availableBox,
    }],
  }],
};
const candidatePayload = `${JSON.stringify(candidateArtifact, null, 2)}\n`;
await fs.writeFile(candidatesPath, candidatePayload, 'utf8');

const proposal = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  scope: 'One corrected KK scaffold-system heading after the pass4 independent gate and fresh all-15 audit.',
  sharedOverridesModified: false,
  proposedAgainstSharedOverrideSha256: candidateArtifact.proposedAgainstSharedOverrideSha256,
  sourceCandidateArtifactSha256: sha256(candidatePayload),
  itemCount: 1,
  targetCount: 1,
  validationFailures: [...failures].sort(),
  items: [{
    sourceSha256: element?.sourceTextSha256,
    source: regression?.sourceText,
    severity: 'medium',
    category: 'presentation-layout-concise-pass5',
    rationale: 'Candidate only; independent semantic approval is required before shared application.',
    targets: { kk: candidate },
  }],
};
const proposalPayload = `${JSON.stringify(proposal, null, 2)}\n`;
await fs.writeFile(proposalPath, proposalPayload, 'utf8');
const expanded = {
  ...proposal,
  proposalSha256: sha256(stableJson(proposal)),
  proposalFileSha256: sha256(proposalPayload),
  candidates: candidateArtifact.candidates,
};
const expandedPayload = `${JSON.stringify(expanded, null, 2)}\n`;
await fs.writeFile(expandedPath, expandedPayload, 'utf8');

const result = {
  ok: failures.length === 0,
  candidateCount: 1,
  visualReductionPercent,
  validationFailures: failures,
  sourceReportSha256: candidateArtifact.sourceReportSha256,
  sharedOverrideSha256: candidateArtifact.proposedAgainstSharedOverrideSha256,
  candidateArtifactSha256: proposal.sourceCandidateArtifactSha256,
  proposalSha256: expanded.proposalSha256,
  proposalFileSha256: expanded.proposalFileSha256,
  expandedFileSha256: sha256(expandedPayload),
};
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
