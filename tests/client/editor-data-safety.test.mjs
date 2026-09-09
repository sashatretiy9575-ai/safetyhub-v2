import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  TEST_EDITOR_LIMITS,
  TEST_EDITOR_TOTAL_QUESTIONS,
  validateTestEditor,
} from '../../lib/admin-test-editor.ts';
import { exclusiveRangeEnd, inclusiveRangeStart } from '../../features/admin/date-range.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const testEditor = await read('components/admin/test-editor.tsx');
const articleEditor = await read('components/admin/admin-editor.tsx');
const legalEditor = await read('components/admin/legal-localizations-editor.tsx');

test('a save merges the server answer instead of replacing the form', () => {
  // `next` was built from the course captured when the request started and
  // written back wholesale, so anything typed while it was in flight — and the
  // form stayed enabled — disappeared without a word.
  assert.match(testEditor, /setCourse\(\(current\) => \(\{ \.\.\.current, \.\.\.savedFields \}\)\)/u);
  assert.match(testEditor, /<fieldset disabled=\{busy\} className="contents">/u);
});

test('saving a draft does not report a published course as withdrawn', () => {
  // `publicationState: 'draft'` was asserted rather than derived.
  assert.doesNotMatch(testEditor, /publicationState: 'draft' as const,/u);
  assert.match(testEditor, /revision\.current\)\?\.contentHash ===\s*\n?\s*payload\.contentHash/u);
});

test('the course validator obeys the limits it declares', () => {
  const course = {
    title: 'x',
    slug: 'ok-slug',
    description: '',
    icon: 'shield-check',
    displayOrder: 0,
    durationMinutes: TEST_EDITOR_LIMITS.durationMax + 1,
    passScore: TEST_EDITOR_LIMITS.passScoreMax + 1,
    attemptsPerCalendarDay: TEST_EDITOR_LIMITS.attemptsPerDayMax + 1,
    attemptResetTimezone: 'Asia/Oral',
    questionVariants: [],
  };
  const result = validateTestEditor(course, { publish: false });
  assert.equal(result.valid, false);
  // The messages quote the declared bounds instead of repeating them by hand,
  // so raising a limit cannot leave the operator reading a stale number.
  const messages = Object.values(result.fieldErrors ?? result.errors ?? {}).flat().join(' ');
  assert.match(messages, new RegExp(String(TEST_EDITOR_LIMITS.durationMax)));
  assert.match(messages, new RegExp(String(TEST_EDITOR_LIMITS.attemptsPerDayMax)));
});

test('the total question count is derived, not typed out', () => {
  assert.equal(
    TEST_EDITOR_TOTAL_QUESTIONS,
    TEST_EDITOR_LIMITS.variantCount * TEST_EDITOR_LIMITS.questionCount,
  );
  assert.doesNotMatch(testEditor, /\/30`\}/u);
  assert.match(testEditor, /TEST_EDITOR_TOTAL_QUESTIONS/u);
});

test('Russian error counts use all three plural forms', () => {
  // The condition had two branches, so anything but one error read
  // "исправьте 2 ошибок".
  assert.match(testEditor, /new Intl\.PluralRules\('ru-RU'\)/u);
  assert.doesNotMatch(testEditor, /length === 1 \? 'ошибку' : 'ошибок'/u);
});

test('two autosaves cannot carry the same draft version', () => {
  assert.match(articleEditor, /if \(autosaveInFlightRef\.current\) return;/u);
  assert.match(articleEditor, /autosaveInFlightRef\.current = false;/u);
});

test('an unsaved new article owns its storage key', () => {
  // Every new article shared the literal key 'new', so two tabs — or one tab
  // after abandoning a draft — restored each other's text.
  assert.doesNotMatch(articleEditor, /useRef\(initialData\?\.id \?\? 'new'\)/u);
  assert.match(articleEditor, /`new:\$\{crypto\.randomUUID\(\)\}`/u);
  // And the restore is announced rather than performed silently.
  assert.match(articleEditor, /Восстановлен локальный черновик от/u);
});

test('the article preview is not parsed while it is closed', () => {
  assert.match(articleEditor, /preview \? blocks\.filter/u);
  // The initial parse used to run in the component body on every render.
  assert.match(articleEditor, /useState<ArticleBlock\[\]>\(\(\) => \{/u);
});

test('saving a legal translation keeps the tab and the text', () => {
  // The parent rebuilds its items array after every save, and the editor
  // rebuilt its whole local draft from it — throwing the operator back to the
  // Russian tab and replacing the text being translated.
  assert.match(legalEditor, /const versionKeyRef = useRef<string \| null>\(null\);/u);
  assert.match(legalEditor, /if \(sameVersion\) \{/u);
  assert.match(legalEditor, /body: local\.body/u);
});

test('both administrative date filters compute the same boundary', () => {
  const attestations = 'features/admin/attestations.ts';
  const history = 'features/admin/data.ts';
  assert.equal(inclusiveRangeStart('2026-01-01'), '2026-01-01T00:00:00.000Z');
  assert.equal(exclusiveRangeEnd('2026-01-01'), '2026-01-02T00:00:00.000Z');
  assert.equal(exclusiveRangeEnd('2026-12-31'), '2027-01-01T00:00:00.000Z');
  for (const value of ['not-a-date', '', null, undefined]) {
    assert.equal(inclusiveRangeStart(value), null);
    assert.equal(exclusiveRangeEnd(value), null);
  }
  return Promise.all([read(attestations), read(history)]).then(([left, right]) => {
    for (const source of [left, right]) {
      assert.doesNotMatch(source, /function dateBoundary/u);
      assert.match(source, /inclusiveRangeStart|exclusiveRangeEnd/u);
    }
  });
});

test('the certificate download stops when its button leaves the page', async () => {
  const button = await read('features/certificates/download-button.tsx');
  assert.match(button, /const resetTimerRef = useRef<number \| null>\(null\);/u);
  assert.match(button, /window\.clearTimeout\(resetTimerRef\.current\)/u);
  assert.match(button, /CERTIFICATE_METADATA_TIMEOUT_MS = 30_000/u);
  assert.match(button, /DOWNLOADED_STATE_RESET_MS = 4_000/u);
});
