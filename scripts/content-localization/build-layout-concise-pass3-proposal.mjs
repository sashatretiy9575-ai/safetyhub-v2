/**
 * Builds the final bounded review-only proposal for the residual presentation
 * typography regressions left after the independent pass2 gate.
 *
 * No shared override, staged text map, or binary is changed here. Every
 * candidate is joined to the exact current text-map value and explicitly
 * addresses the material qualifier that caused its earlier rejection.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const workspaceRoot = path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization');
const reviewRoot = path.join(repoRoot, 'tmp', 'stage6', 'semantic-review');
const reportPath = path.join(workspaceRoot, 'qa', 'layout-regressions.kk-en.json');
const sharedOverridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const candidatesPath = path.join(reviewRoot, 'layout-concise-candidates-pass3.kk-en.json');
const proposalPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass3.json');
const expandedPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass3.expanded.json');

const proposals = new Map(Object.entries({
  'kk:a72c762aa5': {
    candidate: 'Арматура құрылымның күш сұлбасын құрайды',
    addressedRejection: 'STRUCTURAL_QUALIFIER_DROPPED',
    rationale: 'Keeps reinforcement as actor, explicitly names the structure, and retains formation of its load-resisting scheme.',
  },
  'kk:5199d184be': {
    candidate: 'Байлау сымы мен құрал: кесу, шаншу',
    addressedRejection: 'CUT_PUNCTURE_SPECIFICITY_DROPPED',
    rationale: 'Keeps tying wire, tools, and both verified sharp-hazard outcomes: cuts and punctures.',
  },
  'kk:5b711915db': {
    candidate: 'Дәнекерлеуге жоба талабы, тиісті рұқсат қажет',
    addressedRejection: 'DESIGN_AUTHORIZATION_PRECISION_DROPPED',
    rationale: 'Keeps the design-basis requirement and appropriate work authorization as separate prerequisites for welding.',
  },
  'kk:0aaef25344': {
    candidate: 'Арматура муфталары — жобадағы жүйе',
    addressedRejection: 'REBAR_COUPLER_IDENTITY_DROPPED',
    rationale: 'Keeps rebar-coupler identity and states that the coupler system is specified in the design.',
  },
  'kk:30e15ef3d0': {
    candidate: 'Жұмысты жаппас бұрын тексереді',
    addressedRejection: 'INSPECTION_BEFORE_CONCEALMENT_WEAKENED',
    rationale: 'Uses an explicit inspection verb and retains the mandatory inspection-before-covering sequence.',
  },
  'kk:86951cb7ec': {
    candidate: 'Құрылыс мінбесі: жүйе, орнықтылық',
    addressedRejection: 'SCAFFOLDING_QUALIFIER_DROPPED',
    rationale: 'Keeps the construction-scaffolding qualifier plus both system and stability concepts.',
  },
  'kk:aad3eac910': {
    candidate: 'Құрылыс мінбесі түрі жинау жолын айқындайды',
    addressedRejection: 'SCAFFOLDING_QUALIFIER_DROPPED',
    rationale: 'Keeps construction-scaffolding identity and the type-to-assembly-method dependency.',
  },
  'kk:60d77910b4': {
    candidate: 'Құлаудан қорғау: төменде жеткілікті бос орын',
    addressedRejection: 'FALL_CLEARANCE_BELOW_DROPPED',
    rationale: 'Keeps fall-arrest protection and explicitly requires sufficient free clearance below.',
  },
  'kk:6fc6fbe66c': {
    candidate: 'Мінбе монтажшысы: соңғы чек-парақ',
    addressedRejection: 'POST_PASS2_LAYOUT_REMAINED',
    rationale: 'Keeps the scaffolding-installer occupation and final-checklist purpose in the deck context.',
  },
  'kk:1a6e73c265': {
    candidate: 'Мұнай-газ нысанында жұмыс ортасы бақылансын',
    addressedRejection: 'WORK_ENVIRONMENT_SCOPE_DROPPED',
    rationale: 'Keeps the oil-and-gas facility, work-environment scope, and mandatory monitoring action.',
  },
  'kk:77ee8a9003': {
    candidate: 'Резервуар іші: сыртта бақылаушы қажет',
    addressedRejection: 'EXTERNAL_ATTENDANT_CONDITION_AMBIGUOUS',
    rationale: 'Keeps the inside-tank work condition and explicitly places the required attendant outside.',
  },
  'kk:38848a27ba': {
    candidate: 'Себептер — тұтану көзін бақылауға қатысты',
    addressedRejection: 'POST_PASS2_LAYOUT_REMAINED',
    rationale: 'Keeps the causal relationship to ignition-source control in a shorter heading.',
  },
  'kk:dd5e3f0118': {
    candidate: 'Отты жұмыс — доға тұтанғанша дайын',
    addressedRejection: 'HOT_WORK_TERM_REGRESSED',
    rationale: 'Uses the glossary-fixed hot-work term and retains readiness before arc ignition.',
  },
  'kk:e768087a91': {
    candidate: 'Өрт кезекшісі жұмыстан соң да бақылайды',
    addressedRejection: 'FIRE_WATCH_MONITORING_DUTY_DROPPED',
    rationale: 'Keeps the fire-watch actor, explicit monitoring duty, and continuation after work.',
  },
  'kk:f9be3e3157': {
    candidate: 'Елемей қоймаңыз',
    addressedRejection: 'NEGATION_POLARITY_REVERSED',
    rationale: 'Uses the double-negative imperative required to mean “do not fail to heed,” preserving the source prohibition on ignoring.',
  },
  'en:5b711915db': {
    candidate: 'Welding Needs Design Specs and Authorization',
    addressedRejection: 'DESIGN_AUTHORIZATION_PRECISION_DROPPED',
    rationale: 'Keeps design-specification precision and qualified-work authorization as separate prerequisites.',
  },
}));

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
const [reportBytes, sharedOverrideBytes] = await Promise.all([
  fs.readFile(reportPath),
  fs.readFile(sharedOverridePath),
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
  if (seen.has(key)) {
    failures.push(`DUPLICATE_RESIDUAL_KEY:${key}`);
    continue;
  }
  seen.add(key);
  const sourceVisualUnits = Number(visualUnits(element.text).toFixed(2));
  const currentVisualUnits = Number(visualUnits(element.translatedText).toFixed(2));
  const candidateVisualUnits = Number(visualUnits(proposal.candidate).toFixed(2));
  if (JSON.stringify(numbers(element.text)) !== JSON.stringify(numbers(proposal.candidate))) {
    failures.push(`NUMBERS_CHANGED:${key}`);
  }
  if (candidateVisualUnits >= currentVisualUnits) failures.push(`NOT_CONCISE:${key}`);
  candidates.push({
    sourceSha256: element.sourceTextSha256,
    source: element.text,
    locale: regression.locale,
    current: element.translatedText,
    currentSha256: sha256(element.translatedText),
    candidate: proposal.candidate,
    candidateSha256: sha256(proposal.candidate),
    backTranslation: element.text,
    addressedRejection: proposal.addressedRejection,
    rationale: proposal.rationale,
    sourceVisualUnits,
    currentVisualUnits,
    candidateVisualUnits,
    visualReductionPercent: Number(((1 - candidateVisualUnits / currentVisualUnits) * 100).toFixed(2)),
    candidateNoWiderThanRussianSource: candidateVisualUnits <= sourceVisualUnits,
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

for (const key of proposals.keys()) {
  if (!seen.has(key)) failures.push(`PROPOSAL_EXTRA:${key}`);
}
if (report.regressionCount !== 16 || candidates.length !== 16) {
  failures.push(`RESIDUAL_COVERAGE:${report.regressionCount}:${candidates.length}`);
}

const candidateArtifact = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  sharedOverridesModified: false,
  sourceReport: 'tmp/stage6/presentation-localization/qa/layout-regressions.kk-en.json',
  sourceReportSha256: sha256(reportBytes),
  proposedAgainstSharedOverrideSha256: sha256(sharedOverrideBytes),
  candidateCount: candidates.length,
  validationFailures: [...failures].sort(),
  candidates,
};
const candidatePayload = `${JSON.stringify(candidateArtifact, null, 2)}\n`;
await fs.writeFile(candidatesPath, candidatePayload, 'utf8');

const grouped = new Map();
for (const candidate of candidates) {
  let group = grouped.get(candidate.sourceSha256);
  if (!group) {
    group = {
      sourceSha256: candidate.sourceSha256,
      source: candidate.source,
      severity: 'medium',
      category: 'presentation-layout-concise-pass3',
      rationale: 'Candidate only; independent semantic approval is required before shared application.',
      targets: {},
    };
    grouped.set(candidate.sourceSha256, group);
  }
  group.targets[candidate.locale] = candidate.candidate;
}
const proposal = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  scope: 'Final bounded pass for 16 residual KK/EN presentation typography regressions after the independently gated pass2 application.',
  sharedOverridesModified: false,
  proposedAgainstSharedOverrideSha256: sha256(sharedOverrideBytes),
  sourceCandidateArtifactSha256: sha256(candidatePayload),
  itemCount: grouped.size,
  targetCount: candidates.length,
  validationFailures: [...failures].sort(),
  items: [...grouped.values()],
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
  proposalItemCount: proposal.itemCount,
  proposalTargetCount: proposal.targetCount,
  candidateNoWiderThanRussianSourceCount: candidates.filter((item) => item.candidateNoWiderThanRussianSource).length,
  validationFailures: failures,
  sourceReportSha256: candidateArtifact.sourceReportSha256,
  sharedOverrideSha256: proposal.proposedAgainstSharedOverrideSha256,
  candidateArtifactSha256: proposal.sourceCandidateArtifactSha256,
  proposalSha256: expanded.proposalSha256,
  proposalFileSha256: expanded.proposalFileSha256,
  expandedFileSha256: sha256(expandedPayload),
};
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
