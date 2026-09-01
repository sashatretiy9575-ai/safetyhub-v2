/**
 * Builds a review-only proposal for the six layout residuals after pass3.
 * It never changes shared overrides, staged text maps, or presentation files.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const reviewRoot = path.join(repoRoot, 'tmp', 'stage6', 'semantic-review');
const reportPath = path.join(workspaceRoot, 'qa', 'layout-regressions.kk-en.json');
const overridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const candidatesPath = path.join(reviewRoot, 'layout-concise-candidates-pass4.kk.json');
const proposalPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass4.json');
const expandedPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass4.expanded.json');

const proposals = new Map(Object.entries({
  'kk:0aaef25344': {
    candidate: 'Жобалық арматура муфта жүйесі қолданылады',
    addressedContract: 'Rebar-coupler identity, actual use, and the design-specified system relation all remain explicit.',
  },
  'kk:86951cb7ec': {
    candidate: 'Құрылыс мінбе жүйесі: тұрақтылық',
    addressedContract: 'Construction-scaffolding identity, system, and stability all remain explicit.',
  },
  'kk:aad3eac910': {
    candidate: 'Құрылыс мінбесі түрі жинауды айқындайды',
    addressedContract: 'Construction-scaffolding type remains the determinant of assembly.',
  },
  'kk:60d77910b4': {
    candidate: 'Құлау тежегішіне төменде жеткілікті орын керек',
    addressedContract: 'Fall-arrest protection, sufficient clearance below, and its necessity all remain explicit.',
  },
  'kk:1a6e73c265': {
    candidate: 'Мұнай-газ нысаны: жұмыс ортасы бақылансын',
    addressedContract: 'The oil-and-gas facility, work-environment scope, and mandatory monitoring action all remain explicit.',
  },
  'kk:dd5e3f0118': {
    candidate: 'Отты жұмысты доға тұтанғанша дайындаңыз',
    addressedContract: 'The glossary-fixed hot-work term, preparation action, and before-arc-ignition sequence all remain explicit.',
  },
}));

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

function numbers(value) {
  return value.match(/\d+(?:[.,]\d+)?/gu) ?? [];
}

await fs.mkdir(reviewRoot, { recursive: true });
const [reportBytes, overrideBytes] = await Promise.all([
  fs.readFile(reportPath),
  fs.readFile(overridePath),
]);
const report = JSON.parse(reportBytes);
const failures = [];
const candidates = [];
const seen = new Set();

for (const regression of report.regressions) {
  const mapPath = path.join(stagedRoot, 'presentations', regression.slug, regression.locale, 'text-map.json');
  const map = JSON.parse(await fs.readFile(mapPath, 'utf8'));
  const slide = map.slides.find((item) => item.slide === regression.slide);
  const element = slide?.elements.find((item) => String(item.shapeId) === String(regression.shapeId));
  if (!element || element.text !== regression.sourceText || element.translatedText !== regression.translatedText) {
    failures.push(`REGRESSION_MAP_JOIN_FAILED:${regression.locale}:${regression.slug}:${regression.slide}:${regression.shapeId}`);
    continue;
  }
  const key = `${regression.locale}:${element.sourceTextSha256.slice(0, 10)}`;
  const proposal = proposals.get(key);
  if (!proposal) {
    failures.push(`PROPOSAL_MISSING:${key}`);
    continue;
  }
  if (seen.has(key)) failures.push(`DUPLICATE_RESIDUAL_KEY:${key}`);
  seen.add(key);
  const currentVisualUnits = Number(visualUnits(element.translatedText).toFixed(2));
  const candidateVisualUnits = Number(visualUnits(proposal.candidate).toFixed(2));
  if (candidateVisualUnits >= currentVisualUnits) failures.push(`NOT_CONCISE:${key}`);
  if (JSON.stringify(numbers(element.text)) !== JSON.stringify(numbers(proposal.candidate))) {
    failures.push(`NUMBERS_CHANGED:${key}`);
  }
  candidates.push({
    sourceSha256: element.sourceTextSha256,
    source: element.text,
    locale: regression.locale,
    current: element.translatedText,
    currentSha256: sha256(element.translatedText),
    candidate: proposal.candidate,
    candidateSha256: sha256(proposal.candidate),
    backTranslation: element.text,
    addressedContract: proposal.addressedContract,
    currentVisualUnits,
    candidateVisualUnits,
    visualReductionPercent: Number(((1 - candidateVisualUnits / currentVisualUnits) * 100).toFixed(2)),
    contexts: [{
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
    }],
  });
}

for (const key of proposals.keys()) if (!seen.has(key)) failures.push(`PROPOSAL_EXTRA:${key}`);
if (report.regressionCount !== 6 || candidates.length !== 6) {
  failures.push(`RESIDUAL_COVERAGE:${report.regressionCount}:${candidates.length}`);
}

const candidateArtifact = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  sharedOverridesModified: false,
  sourceReportSha256: sha256(reportBytes),
  proposedAgainstSharedOverrideSha256: sha256(overrideBytes),
  candidateCount: candidates.length,
  validationFailures: [...failures].sort(),
  candidates,
};
const candidatePayload = `${JSON.stringify(candidateArtifact, null, 2)}\n`;
await fs.writeFile(candidatesPath, candidatePayload, 'utf8');

const items = candidates.map((candidate) => ({
  sourceSha256: candidate.sourceSha256,
  source: candidate.source,
  severity: 'medium',
  category: 'presentation-layout-concise-pass4',
  rationale: 'Candidate only; independent semantic approval is required before shared application.',
  targets: { [candidate.locale]: candidate.candidate },
}));
const proposal = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  scope: 'Smallest corrected proposal for the six residual KK typography regressions after pass3.',
  sharedOverridesModified: false,
  proposedAgainstSharedOverrideSha256: sha256(overrideBytes),
  sourceCandidateArtifactSha256: sha256(candidatePayload),
  itemCount: items.length,
  targetCount: candidates.length,
  validationFailures: [...failures].sort(),
  items,
};
const proposalPayload = `${JSON.stringify(proposal, null, 2)}\n`;
await fs.writeFile(proposalPath, proposalPayload, 'utf8');
const expanded = {
  ...proposal,
  proposalSha256: sha256(stableJson(proposal)),
  proposalFileSha256: sha256(proposalPayload),
  candidates,
};
const expandedPayload = `${JSON.stringify(expanded, null, 2)}\n`;
await fs.writeFile(expandedPath, expandedPayload, 'utf8');

const result = {
  ok: failures.length === 0,
  candidateCount: candidates.length,
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
