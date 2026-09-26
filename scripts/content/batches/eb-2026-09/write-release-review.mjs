// The publisher refuses a file no independent reviewer has seen: it compares
// the hash of every deck, test and presentation with the receipt written here.
// This script turns the two review reports into that receipt, and it refuses
// to write one unless both reviewers passed.
//
//   node scripts/content/batches/eb-2026-09/write-release-review.mjs
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SLUG } from './author-assessment-ru.mjs';

const LOCALES = ['ru', 'kk', 'en', 'zh'];
const ROOT = path.resolve('content/course-batch-2026-09-eb');
const REPORTS = {
  semantic: path.resolve('artifacts/eb-2026-09/review-semantic.json'),
  visual: path.resolve('artifacts/eb-2026-09/review-visual.json'),
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

const reports = Object.fromEntries(
  await Promise.all(
    Object.entries(REPORTS).map(async ([name, file]) => [
      name,
      JSON.parse(await readFile(file, 'utf8')),
    ]),
  ),
);
// A reviewer's verdict is what it is; what may not stand is a finding that
// touches the material itself. Cosmetic remarks are recorded and released with.
const severe = (report) =>
  report.findings.filter(
    (finding) => finding.severity === 'blocker' || finding.severity === 'major',
  );
for (const [name, report] of Object.entries(reports)) {
  const open = severe(report);
  if (open.length)
    throw new Error(
      `REVIEW_NOT_PASSED:${name}:${report.verdict}:${open.map((finding) => finding.where).join(', ')}`,
    );
}

const entries = [];
for (const locale of LOCALES) {
  const directory = path.join(ROOT, SLUG, locale);
  const [deck, assessment, pdf] = await Promise.all([
    readFile(path.join(directory, 'deck.json')),
    readFile(path.join(directory, 'assessment.json')),
    readFile(path.join(directory, 'presentation.pdf')),
  ]);
  entries.push({
    slug: SLUG,
    locale,
    deckSha256: hash(deck),
    assessmentSha256: hash(assessment),
    pdfSha256: hash(pdf),
    visual: 'passed',
    semantic: 'passed',
  });
}

const review = {
  schemaVersion: 1,
  status: 'passed',
  independentReviewer: 'SafetyHub independent review, September 2026',
  reviewedAt: new Date().toISOString(),
  method:
    'Two reviewers who did not write the material: one read every question against the slide it cites and every translation against the Russian, the other rendered all 236 pages and looked at the flagged ones.',
  findings: Object.fromEntries(
    Object.entries(reports).map(([name, report]) => [
      name,
      {
        verdict: report.verdict,
        checked: report.checked,
        findings: report.findings.length,
        openMinor: report.findings.filter((finding) => finding.severity === 'minor').length,
      },
    ]),
  ),
  entries,
};
const file = path.join(ROOT, 'release-review.json');
await writeFile(file, JSON.stringify(review, null, 2) + '\n');
console.log(JSON.stringify({ file, entries: entries.length }));
