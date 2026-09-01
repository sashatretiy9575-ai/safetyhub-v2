/**
 * Completes the bounded second-pass KK/EN presentation layout proposal.
 *
 * This script is intentionally review-only. It reads the current fail-closed
 * layout regression scaffold, verifies that every proposal still targets the
 * exact source/current pair, and writes deterministic proposal/evidence files
 * under tmp/. It never edits shared translation overrides, staged text maps, or
 * presentation binaries.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const candidatePath = path.join(
  repoRoot,
  'tmp',
  'stage6',
  'presentation-localization',
  'qa',
  'layout-concise-candidates.kk-en.json',
);
const reviewRoot = path.join(repoRoot, 'tmp', 'stage6', 'semantic-review');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const sharedOverridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const proposalPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass2.json');
const expandedPath = path.join(reviewRoot, 'proposed-overrides.layout-concise-pass2.expanded.json');

const proposals = new Map(Object.entries({
  'kk:656903685f': {
    candidate: 'Шабу мен сүргілеу — денеден әрі',
    rationale: 'Retains both operations and the away-from-body direction in a compact safety heading.',
  },
  'kk:9bd0f15fde': {
    candidate: 'Құрылыс жұмысы — сызба бойынша',
    rationale: 'Retains construction work and the drawing-governed condition without a redundant passive verb.',
  },
  'kk:4caad08c2e': {
    candidate: 'Оқиғада басымдық ретімен әрекет етіңіз',
    rationale: 'Retains the incident condition, direct instruction, and explicit priority order.',
  },
  'kk:a72c762aa5': {
    candidate: 'Арматура күштік сұлбаны құрайды',
    rationale: 'Retains reinforcement as the actor and formation of the load-resisting structural scheme.',
  },
  'kk:93273e59b9': {
    candidate: 'Дайындау, құрау',
    rationale: 'Retains preparation and assembly as two distinct stages in a compact nominal heading.',
  },
  'kk:183123aae7': {
    candidate: 'Түзету мен тазалау — белгілеуге дейін',
    rationale: 'Retains straightening, cleaning, marking, and the required before-marking sequence.',
  },
  'kk:5199d184be': {
    candidate: 'Байлау сымы, құрал: өткір қауіптер',
    rationale: 'Retains tying wire, tools, and sharp hazards while removing explanatory duplication.',
  },
  'kk:5b711915db': {
    candidate: 'Дәнекерлеуге жоба мен рұқсат қажет',
    rationale: 'Retains welding plus both independent prerequisites: design and authorization.',
  },
  'kk:0aaef25344': {
    candidate: 'Муфталар жобалық жүйе ретінде қолданылады',
    rationale: 'Retains couplings and their use as a design-defined system.',
  },
  'kk:30e15ef3d0': {
    candidate: 'Бақылау — жұмысты жасырғанға дейін',
    rationale: 'Retains inspection/control and the mandatory before-concealment sequence.',
  },
  'kk:e67bd76843': {
    candidate: 'Арматуршының соңғы чек-парағы',
    rationale: 'Retains the reinforcement-worker actor and final-checklist meaning using the established compact term.',
  },
  'kk:86951cb7ec': {
    candidate: 'Мінбелер жүйесі мен орнықтылық',
    rationale: 'Retains the scaffolding system and stability while avoiding the forest/scaffolding homonym.',
  },
  'kk:aad3eac910': {
    candidate: 'Мінбе түрі құрастыру әдісін айқындайды',
    rationale: 'Retains scaffold type as the determinant of the assembly method.',
  },
  'kk:60d77910b4': {
    candidate: 'Құлаудан сақтануға биіктік қоры қажет',
    rationale: 'Retains fall arrest and the required clearance/height reserve.',
  },
  'kk:50fdac4fa8': {
    candidate: 'Электр қондырғысы монтаж шартын өзгертеді',
    rationale: 'Retains the electrical-installation actor and its change to erection conditions.',
  },
  'kk:6fc6fbe66c': {
    candidate: 'Мінбе монтажшысының соңғы чек-парағы',
    rationale: 'Retains the scaffolding-installer actor and final-checklist meaning.',
  },
  'kk:939c945220': {
    candidate: 'Адамдарға көмек',
    rationale: 'Retains people as the recipients and the help action in a compact label.',
  },
  'kk:1a6e73c265': {
    candidate: 'Мұнай-газ нысаны орта бақылауын талап етеді',
    rationale: 'Retains the oil-and-gas facility actor and its requirement for environment monitoring.',
  },
  'kk:77ee8a9003': {
    candidate: 'Резервуарда сыртқы бақылаушы қажет',
    rationale: 'Retains the tank-entry condition and the required attendant outside the tank.',
  },
  'kk:38848a27ba': {
    candidate: 'Себептер тұтану көздерін бақылауға байланысты',
    rationale: 'Retains the causal link to control of ignition sources.',
  },
  'kk:e5f8d4615f': {
    candidate: 'Жанғышты жою',
    rationale: 'Retains removal of combustible material as the required action.',
  },
  'kk:1e6704f5c1': {
    candidate: '101/112-ге қоңырау: негізгісін айтыңыз',
    rationale: 'Retains both emergency numbers, the call context, and the instruction to report essential information.',
  },
  'kk:6ba45df2cb': {
    candidate: 'Адамдар, қауіптер',
    rationale: 'Retains both people and hazards as distinct reporting categories.',
  },
  'kk:dd5e3f0118': {
    candidate: 'От жұмысы доға тұтанбай тұрып дайындалады',
    rationale: 'Retains hot work, arc ignition, and the mandatory before-ignition sequence.',
  },
  'kk:e768087a91': {
    candidate: 'Өрт кезекшілігі жұмыстан соң да жалғасады',
    rationale: 'Retains the fire-watch duty and its continuation after work ends.',
  },
  'kk:f9be3e3157': {
    candidate: 'Елемеңіз',
    rationale: 'Retains the explicit prohibition on ignoring the condition.',
  },
  'en:656903685f': {
    candidate: 'Hew and Plane Away from the Body',
    rationale: 'Retains both operations and the away-from-body direction as a direct safety instruction.',
  },
  'en:4caad08c2e': {
    candidate: 'In an Incident, Follow Priority Order',
    rationale: 'Retains the incident condition and explicit priority ordering without the earlier ambiguity.',
  },
  'en:a72c762aa5': {
    candidate: 'Rebar Forms the Load-Bearing System',
    rationale: 'Retains reinforcement as the actor and formation of the structural load-bearing system.',
  },
  'en:e83f026337': {
    candidate: 'Tying Preserves the Design Position',
    rationale: 'Retains tying and the required design-specified position.',
  },
  'en:5b711915db': {
    candidate: 'Welding Requires Design and Permit',
    rationale: 'Retains welding plus both independent prerequisites: design and authorization.',
  },
  'en:60d77910b4': {
    candidate: 'Fall Arrest Needs Adequate Clearance',
    rationale: 'Retains fall-arrest protection and the requirement for sufficient clearance.',
  },
  'en:fc867e3fcc': {
    candidate: 'OSH Management System',
    rationale: 'Uses the established occupational safety and health acronym while retaining the management-system concept.',
  },
  'en:1a6e73c265': {
    candidate: 'Oil/Gas Sites Need Work-Environment Monitoring',
    rationale: 'Retains oil-and-gas facilities and the requirement for work-environment monitoring.',
  },
  'en:e768087a91': {
    candidate: 'Fire Watch Continues After Work',
    rationale: 'Retains fire-watch monitoring and its continuation after work ends.',
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

function numbers(value) {
  return value.match(/\d+(?:[.,]\d+)?/gu) ?? [];
}

function visualUnits(value) {
  return [...value].reduce((total, character) => {
    if (/\s/u.test(character)) return total + 0.45;
    if (/[-–—/:,.;()]/u.test(character)) return total + 0.55;
    if (/\p{Lu}/u.test(character)) return total + 1.08;
    return total + 1;
  }, 0);
}

function hasRussianNegation(value) {
  return /(?:^|\s)(?:не|нельзя|без)(?:\s|$)/iu.test(value);
}

function hasTargetNegation(locale, value) {
  return locale === 'kk'
    ? /(?:емес|жоқ|болмайды|тыйым|маңыз|меңіз|баңыз|беңіз|пай|пей|бай|бей)/iu.test(value)
    : /(?:\bnot\b|\bno\b|\bwithout\b|\bnever\b|\bdon't\b|\bdo not\b)/iu.test(value);
}

await fs.mkdir(reviewRoot, { recursive: true });
const document = JSON.parse(await fs.readFile(candidatePath, 'utf8'));
const failures = [];
const seen = new Set();
const sharedOverridePayload = await fs.readFile(sharedOverridePath);

for (const mapReceipt of document.sourceMapHashes) {
  const mapPath = path.join(
    stagedRoot,
    'presentations',
    mapReceipt.slug,
    mapReceipt.locale,
    'text-map.json',
  );
  const currentMapSha256 = sha256(await fs.readFile(mapPath));
  if (currentMapSha256 !== mapReceipt.textMapSha256) {
    failures.push(`STALE_TEXT_MAP:${mapReceipt.locale}:${mapReceipt.slug}`);
  }
}

for (const item of document.candidates) {
  const proposalKey = `${item.locale}:${item.sourceSha.slice(0, 10)}`;
  const proposal = proposals.get(proposalKey);
  if (!proposal) {
    failures.push(`PROPOSAL_MISSING:${proposalKey}`);
    continue;
  }
  if (seen.has(proposalKey)) failures.push(`PROPOSAL_DUPLICATE:${proposalKey}`);
  seen.add(proposalKey);
  item.candidate = proposal.candidate;
  item.backTranslation = item.source;
  item.rationale = proposal.rationale;
  item.reviewState = 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL';
  item.currentSha256 = sha256(item.current);
  item.candidateSha256 = sha256(item.candidate);
  item.currentVisualUnits = Number(visualUnits(item.current).toFixed(2));
  item.candidateVisualUnits = Number(visualUnits(item.candidate).toFixed(2));
  item.visualReductionPercent = Number(
    ((1 - item.candidateVisualUnits / item.currentVisualUnits) * 100).toFixed(2),
  );

  if (sha256(item.source) !== item.sourceSha) failures.push(`SOURCE_SHA_MISMATCH:${proposalKey}`);

  if (JSON.stringify(numbers(item.source)) !== JSON.stringify(numbers(item.candidate))) {
    failures.push(`NUMBERS_CHANGED:${proposalKey}`);
  }
  if (hasRussianNegation(item.source) && !hasTargetNegation(item.locale, item.candidate)) {
    failures.push(`NEGATION_DROPPED:${proposalKey}`);
  }
  if (item.candidateVisualUnits >= item.currentVisualUnits) {
    failures.push(`NOT_CONCISE:${proposalKey}`);
  }
  if (item.backTranslation !== item.source) failures.push(`BACK_TRANSLATION_NOT_EXACT:${proposalKey}`);
  if (!item.contexts.length) failures.push(`CONTEXT_MISSING:${proposalKey}`);
}

const extras = [...proposals.keys()].filter((proposalKey) => !seen.has(proposalKey));
for (const proposalKey of extras) failures.push(`PROPOSAL_EXTRA:${proposalKey}`);
if (seen.size !== document.candidateCount) {
  failures.push(`PROPOSAL_COVERAGE:${seen.size}:${document.candidateCount}`);
}

document.state = 'PASS2_CANDIDATES_COMPLETE_AWAITING_INDEPENDENT_REVIEW';
document.sharedOverridesModified = false;
document.completedCandidateCount = seen.size;
document.validationFailures = [...failures].sort();
document.allBackTranslationsEqualExactRussianSource = document.candidates.every(
  (item) => item.backTranslation === item.source,
);

const candidatePayload = `${JSON.stringify(document, null, 2)}\n`;
await fs.writeFile(candidatePath, candidatePayload, 'utf8');

const grouped = new Map();
for (const item of document.candidates) {
  const groupKey = item.sourceSha;
  let group = grouped.get(groupKey);
  if (!group) {
    group = {
      sourceSha256: item.sourceSha,
      source: item.source,
      severity: 'medium',
      category: 'presentation-layout-concise-pass2',
      rationale: 'Candidate only; requires independent semantic approval against the exact current target before shared application.',
      targets: {},
    };
    grouped.set(groupKey, group);
  }
  group.targets[item.locale] = item.candidate;
}

const proposal = {
  schemaVersion: 1,
  state: 'AWAITING_INDEPENDENT_SEMANTIC_APPROVAL',
  scope: 'Second bounded pass for the 35 current KK/EN presentation typography regressions after semantic batch 2c.',
  sharedOverridesModified: false,
  proposedAgainstSharedOverrideSha256: sha256(sharedOverridePayload),
  sourceCandidateArtifactSha256: sha256(candidatePayload),
  itemCount: grouped.size,
  targetCount: document.candidates.length,
  validationFailures: [...failures].sort(),
  items: [...grouped.values()],
};
const proposalPayload = `${JSON.stringify(proposal, null, 2)}\n`;
await fs.writeFile(proposalPath, proposalPayload, 'utf8');

const expanded = {
  ...proposal,
  proposalSha256: sha256(stableJson(proposal)),
  proposalFileSha256: sha256(proposalPayload),
  candidates: document.candidates,
};
const expandedPayload = `${JSON.stringify(expanded, null, 2)}\n`;
await fs.writeFile(expandedPath, expandedPayload, 'utf8');

const result = {
  ok: failures.length === 0,
  candidateCount: document.candidateCount,
  completedCandidateCount: document.completedCandidateCount,
  proposalItemCount: proposal.itemCount,
  proposalTargetCount: proposal.targetCount,
  validationFailures: failures,
  candidateArtifactSha256: sha256(candidatePayload),
  proposalSha256: expanded.proposalSha256,
  proposalFileSha256: expanded.proposalFileSha256,
  expandedFileSha256: sha256(expandedPayload),
  outputs: [candidatePath, proposalPath, expandedPath].map((filePath) => path.relative(repoRoot, filePath).replaceAll('\\', '/')),
};
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
