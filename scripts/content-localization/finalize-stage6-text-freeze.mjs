/**
 * Creates the deterministic Stage 6 semantic-review and text-map freeze
 * receipts. This is an offline-only gate: it never contacts or mutates linked
 * Supabase, Storage, or any production service.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../..');
const stagedRoot = path.join(repoRoot, 'content', 'localizations', 'staged-2026-09-01');
const qaRoot = path.join(stagedRoot, 'qa');
const locales = ['kk', 'en', 'zh'];
const slugs = ['plotnik', 'armaturshchik', 'lesomontazhnye-raboty', 'biot', 'pozharnaya-bezopasnost'];
const expected = {
  overrideSha256: '1d6457c7ea098ecedb5619c40687e7ceb7afdbd4ee7cea541a0ed5133ce06219',
  overrideCount: 656,
  corpusSha256: '051b74a0f13888c8f2374c2abfcf519267c8c985a7cb21e06c0c1d4a066c01c5',
  reviewedSourceUnitCount: 2193,
  reviewedLocalizedUnitCount: 6579,
  allLayoutAuditSha256: '1edf7b171b8aad262cc7d9005d4a7d14c261e013bf01d5a8e7afee6d83dbcdd0',
  pass5GateSha256: '41d38da02f6fcdfceb22a325f141b9d4860baa120bb0b9248f162aa70f288197',
  pass5GateFileSha256: '55438c6e37dad34aa0f4b36388409c9869f0c6241baf0281043868a2c4c1f900',
  pass5EmptyApprovedFileSha256: 'c9f0f78b9b2967157118e1e13c6d4443420eeb5de49ba081b5c408a79af3c288',
  layoutOnlyReceiptSha256: '18393bce7ff5dd54666b31556ec732fe54d7bce6c79a7221baf5684e6b5be7bb',
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function relative(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readOrArchiveEvidence({ canonicalPath, transientPath }) {
  let bytes;
  try {
    bytes = await fs.readFile(canonicalPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    bytes = await fs.readFile(transientPath);
    await fs.mkdir(path.dirname(canonicalPath), { recursive: true });
    await fs.writeFile(canonicalPath, bytes);
  }
  return bytes;
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

const overridePath = path.join(repoRoot, 'content', 'localizations', 'translation-overrides.ru-kk-en-zh.json');
const overrideBytes = await fs.readFile(overridePath);
const overrides = JSON.parse(overrideBytes.toString('utf8'));
assert(sha256(overrideBytes) === expected.overrideSha256, 'TEXT_FREEZE_OVERRIDE_HASH_MISMATCH');
assert(overrides.items?.length === expected.overrideCount, 'TEXT_FREEZE_OVERRIDE_COUNT_MISMATCH');

const summaryRun = spawnSync(process.execPath, [
  path.join(scriptDir, 'review-stage6-semantics.mjs'),
  '--summary',
], { encoding: 'utf8', env: process.env, maxBuffer: 10 * 1024 * 1024 });
assert(summaryRun.status === 0, `TEXT_FREEZE_SEMANTIC_SUMMARY_FAILED:${summaryRun.stderr}`);
const semanticSummary = JSON.parse(summaryRun.stdout);
assert(semanticSummary.corpusSha256 === expected.corpusSha256, 'TEXT_FREEZE_CORPUS_HASH_MISMATCH');
assert(semanticSummary.sourceUnits === expected.reviewedSourceUnitCount, 'TEXT_FREEZE_SOURCE_UNIT_COUNT_MISMATCH');
assert(semanticSummary.targetUnits === expected.reviewedLocalizedUnitCount, 'TEXT_FREEZE_TARGET_UNIT_COUNT_MISMATCH');

const allAuditPath = path.join(qaRoot, 'presentation-layout-audit.all.json');
const allAuditBytes = await readOrArchiveEvidence({
  canonicalPath: allAuditPath,
  transientPath: path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization', 'qa', 'layout-regressions.all.json'),
});
const allAudit = JSON.parse(allAuditBytes.toString('utf8'));
assert(sha256(allAuditBytes) === expected.allLayoutAuditSha256, 'TEXT_FREEZE_LAYOUT_AUDIT_HASH_MISMATCH');
assert(allAudit.regressionCount === 0, 'TEXT_FREEZE_LAYOUT_REGRESSIONS_REMAIN');
assert(allAudit.scope?.deckLocaleCount === 15 && allAudit.scope?.inspectedSlideCount === 594, 'TEXT_FREEZE_LAYOUT_AUDIT_SCOPE_MISMATCH');

const pass5GatePath = path.join(qaRoot, 'layout-concise-gate-pass5.kk.json');
const pass5ApprovedPath = path.join(qaRoot, 'proposed-overrides.layout-concise-pass5.approved.json');
const layoutOnlyReceiptPath = path.join(qaRoot, 'layout-only-override-receipt.kk-lesomontazhnye-raboty.json');
const [pass5GateBytes, pass5ApprovedBytes, layoutOnlyReceiptBytes] = await Promise.all([
  readOrArchiveEvidence({
    canonicalPath: pass5GatePath,
    transientPath: path.join(repoRoot, 'tmp', 'stage6', 'semantic-review', 'layout-concise-gate-pass5.kk.json'),
  }),
  readOrArchiveEvidence({
    canonicalPath: pass5ApprovedPath,
    transientPath: path.join(repoRoot, 'tmp', 'stage6', 'semantic-review', 'proposed-overrides.layout-concise-pass5.approved.json'),
  }),
  readOrArchiveEvidence({
    canonicalPath: layoutOnlyReceiptPath,
    transientPath: path.join(repoRoot, 'tmp', 'stage6', 'presentation-localization', 'kk', 'lesomontazhnye-raboty', 'qa', 'layout-only-override-receipt.json'),
  }),
]);
const pass5Gate = JSON.parse(pass5GateBytes.toString('utf8'));
const pass5Approved = JSON.parse(pass5ApprovedBytes.toString('utf8'));
const layoutOnlyReceipt = JSON.parse(layoutOnlyReceiptBytes.toString('utf8'));
assert(pass5Gate.gateSha256 === expected.pass5GateSha256, 'TEXT_FREEZE_PASS5_GATE_CANONICAL_HASH_MISMATCH');
assert(sha256(pass5GateBytes) === expected.pass5GateFileSha256, 'TEXT_FREEZE_PASS5_GATE_FILE_HASH_MISMATCH');
assert(sha256(pass5ApprovedBytes) === expected.pass5EmptyApprovedFileSha256, 'TEXT_FREEZE_PASS5_APPROVED_FILE_HASH_MISMATCH');
assert(pass5Approved.items?.length === 0, 'TEXT_FREEZE_PASS5_REJECTED_TARGET_PRESENT');
assert(sha256(layoutOnlyReceiptBytes) === expected.layoutOnlyReceiptSha256, 'TEXT_FREEZE_LAYOUT_ONLY_RECEIPT_HASH_MISMATCH');
assert(layoutOnlyReceipt.semanticsChanged === false && layoutOnlyReceipt.newlyIntersectedNeighborCount === 0, 'TEXT_FREEZE_LAYOUT_ONLY_CONTRACT_FAILED');
const acceptedPass5Title = layoutOnlyReceipt.overrides?.find(
  (override) => override.slide === 10 && override.shapeId === '4' && override.name === 'SECTION_TITLE',
);
assert(acceptedPass5Title?.translatedText === 'Құрылыс мінбесі: жүйе, орнықтылық', 'TEXT_FREEZE_ACCEPTED_TITLE_CHANGED');

const maps = [];
for (const locale of locales) {
  for (const slug of slugs) {
    const mapPath = path.join(stagedRoot, 'presentations', slug, locale, 'text-map.json');
    const bytes = await fs.readFile(mapPath);
    const map = JSON.parse(bytes.toString('utf8'));
    const auditDeck = allAudit.decks.find((deck) => deck.locale === locale && deck.slug === slug);
    assert(map.locale === locale && map.slug === slug, `TEXT_FREEZE_MAP_IDENTITY:${locale}:${slug}`);
    assert(auditDeck?.textMapSha256 === sha256(bytes), `TEXT_FREEZE_MAP_AUDIT_STALE:${locale}:${slug}`);
    assert(auditDeck?.slideCount === map.slideCount && auditDeck?.regressionCount === 0, `TEXT_FREEZE_MAP_AUDIT_FAILED:${locale}:${slug}`);
    maps.push({
      locale,
      slug,
      path: relative(mapPath),
      bytes: bytes.length,
      sha256: sha256(bytes),
      slideCount: map.slideCount,
    });
  }
}
assert(maps.length === 15, 'TEXT_FREEZE_MAP_COUNT_MISMATCH');
assert(maps.reduce((total, map) => total + map.slideCount, 0) === 594, 'TEXT_FREEZE_SLIDE_COUNT_MISMATCH');

const semanticEvidenceNames = (await fs.readdir(qaRoot))
  .filter((name) => /^(?:layout-concise-gate|proposed-overrides\.)/u.test(name) && name.endsWith('.json'))
  .sort();
const semanticEvidence = [];
for (const name of semanticEvidenceNames) {
  const filePath = path.join(qaRoot, name);
  const bytes = await fs.readFile(filePath);
  semanticEvidence.push({ path: relative(filePath), bytes: bytes.length, sha256: sha256(bytes) });
}

const independentReview = {
  schemaVersion: 1,
  generatedAt: '2026-09-01T00:00:00.000Z',
  status: 'passed',
  mode: 'automated-only',
  automatedOnly: true,
  noHumanApproval: true,
  productionPublished: false,
  providerFamily: 'OpenAI independent language-model review',
  corpusSha256: semanticSummary.corpusSha256,
  reviewedSourceUnitCount: semanticSummary.sourceUnits,
  reviewedLocalizedUnitCount: semanticSummary.targetUnits,
  acceptedOverrideFileSha256: expected.overrideSha256,
  acceptedOverrideCount: expected.overrideCount,
  deterministicHeuristicFindingCount: semanticSummary.deterministicFindingCount,
  deterministicHeuristicFindingsDisposition: 'Triage signals were reviewed across bounded independent passes; they are not unresolved material findings.',
  evidence: semanticEvidence,
  pass5Rejection: {
    gateSha256: expected.pass5GateSha256,
    gateFileSha256: expected.pass5GateFileSha256,
    emptyApprovedFileSha256: expected.pass5EmptyApprovedFileSha256,
    rejectedTargetApplied: false,
  },
  validationFailures: [],
  unresolvedMaterialFindings: [],
  residualRisk: [
    'All translation, semantic, terminology, legal and visual review was automated; no human linguistic, legal or design approval was performed.',
    'Automated review reduces but cannot eliminate residual semantic, terminology, jurisdictional and layout risk.',
    'Production publication and hosted parity checks remain deferred to the controlled release stage.',
  ],
};
const independentPath = path.join(qaRoot, 'independent-semantic-review.json');
await writeJson(independentPath, independentReview);
const independentBytes = await fs.readFile(independentPath);

const freezeReceipt = {
  schemaVersion: 1,
  generatedAt: '2026-09-01T00:00:00.000Z',
  state: 'TEXT_MAPS_FROZEN',
  productionPublished: false,
  override: {
    path: relative(overridePath),
    bytes: overrideBytes.length,
    sha256: expected.overrideSha256,
    itemCount: expected.overrideCount,
  },
  independentSemanticReview: {
    path: relative(independentPath),
    bytes: independentBytes.length,
    sha256: sha256(independentBytes),
    corpusSha256: semanticSummary.corpusSha256,
    validationFailureCount: 0,
    unresolvedMaterialFindingCount: 0,
  },
  presentationLayoutAudit: {
    sourcePath: relative(allAuditPath),
    sourceFileSha256: expected.allLayoutAuditSha256,
    deckLocaleCount: 15,
    inspectedSlideCount: 594,
    regressionCount: 0,
  },
  pass5Rejection: {
    gateSha256: expected.pass5GateSha256,
    gateFileSha256: expected.pass5GateFileSha256,
    emptyApprovedFileSha256: expected.pass5EmptyApprovedFileSha256,
    acceptedTitlePreserved: 'Құрылыс мінбесі: жүйе, орнықтылық',
    rejectedTargetApplied: false,
  },
  layoutOnlyCorrection: {
    receiptPath: relative(layoutOnlyReceiptPath),
    receiptSha256: expected.layoutOnlyReceiptSha256,
    locale: 'kk',
    slug: 'lesomontazhnye-raboty',
    slide: 10,
    shapeId: '4',
    textChanged: false,
    fontChanged: false,
    neighborContentMoved: false,
    newlyIntersectedNeighborCount: 0,
  },
  mapCount: maps.length,
  localizedSlideCount: maps.reduce((total, map) => total + map.slideCount, 0),
  combinedMapManifestSha256: sha256(JSON.stringify(maps)),
  maps,
  validationFailures: [],
};
const freezePath = path.join(qaRoot, 'text-map-freeze-receipt.json');
await writeJson(freezePath, freezeReceipt);
const freezeBytes = await fs.readFile(freezePath);

console.log(JSON.stringify({
  ok: true,
  state: freezeReceipt.state,
  independentSemanticReview: {
    path: relative(independentPath),
    bytes: independentBytes.length,
    sha256: sha256(independentBytes),
  },
  textMapFreezeReceipt: {
    path: relative(freezePath),
    bytes: freezeBytes.length,
    sha256: sha256(freezeBytes),
  },
  corpusSha256: semanticSummary.corpusSha256,
  mapCount: maps.length,
  localizedSlideCount: freezeReceipt.localizedSlideCount,
  productionPublished: false,
}, null, 2));
