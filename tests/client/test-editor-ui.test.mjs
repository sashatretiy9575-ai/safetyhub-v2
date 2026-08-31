import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clearTestEditorDraft,
  parseTestEditorDraft,
  readTestEditorDraft,
  testEditorDraftStorageKey,
  validateTestEditor,
  writeTestEditorDraft,
} from '../../lib/admin-test-editor.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const stableUuid = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;

function validPayload() {
  let id = 1;
  const presentationId = stableUuid(9999);
  return {
    slug: 'safety-basics',
    title: 'Основы безопасности',
    description: 'Проверка знаний',
    icon: 'shield',
    displayOrder: 1,
    durationMinutes: 15,
    passScore: 7,
    attemptsPerCalendarDay: 8,
    attemptResetTimezone: 'Asia/Oral',
    presentationId,
    presentation: {
      id: presentationId,
      bucket: 'course-presentations',
      path: 'course/presentation/file.pdf',
      thumbnailPath: 'course/presentation/thumb.webp',
      pageCount: 25,
      sha256: 'a'.repeat(64),
      byteSize: 1_024,
      status: 'ready',
    },
    jurisdiction: '',
    effectiveDate: '',
    sources: [],
    questionVariants: [1, 2, 3].map((variantNumber) => ({
      id: stableUuid(id++),
      variantNumber,
      questions: Array.from({ length: 10 }, (_, questionIndex) => ({
        id: stableUuid(id++),
        text: `Вопрос варианта ${variantNumber}, номер ${questionIndex + 1}`,
        options: Array.from({ length: 4 }, (_, optionIndex) => ({
          id: stableUuid(id++),
          text: `Вариант ответа ${optionIndex + 1}`,
        })),
        correctOptionId: stableUuid(id - 4),
        explanation: '',
      })),
    })),
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('publication validation enforces three variants with ten questions and four stable options', () => {
  const valid = validateTestEditor(validPayload());
  assert.equal(valid.valid, true);
  assert.equal(valid.completedCount, 30);
  assert.deepEqual(
    valid.questionComplete.map((questions) => questions.length),
    [10, 10, 10],
  );

  const invalidPayload = validPayload();
  invalidPayload.questionVariants[0].questions[0].text = '';
  invalidPayload.questionVariants[0].questions[0].options[0].text = '';
  const invalid = validateTestEditor(invalidPayload);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.completedCount, 29);
  assert.equal(invalid.firstInvalidFieldId, 'variant-0-question-0');
  assert.equal(invalid.firstInvalidVariantIndex, 0);
  assert.equal(invalid.firstInvalidQuestionIndex, 0);
  assert.match(invalid.fieldErrors['variant-0-question-0-option-0'], /варианта/iu);
});

test('draft validation allows the metadata-only shell required before presentation upload', () => {
  const shell = validPayload();
  shell.presentationId = null;
  shell.presentation = null;
  shell.questionVariants = [];
  assert.equal(validateTestEditor(shell, { publish: false }).valid, true);
  assert.equal(validateTestEditor(shell).valid, false);
});

test('duplicate question and option wording warns without blocking publication', () => {
  const payload = validPayload();
  payload.questionVariants[0].questions[1].text = `  ${payload.questionVariants[0].questions[0].text.toUpperCase()}  `;
  payload.questionVariants[0].questions[0].options[1].text = ` ${payload.questionVariants[0].questions[0].options[0].text.toUpperCase()} `;

  const result = validateTestEditor(payload);
  assert.equal(result.valid, true);
  assert.match(result.fieldWarnings['variant-0-question-0'], /повторяется/iu);
  assert.match(result.fieldWarnings['variant-0-question-1'], /повторяется/iu);
  assert.match(result.fieldWarnings['variant-0-question-0-option-0'], /повторяется/iu);
  assert.match(result.fieldWarnings['variant-0-question-0-option-1'], /повторяется/iu);
});

test('versioned local drafts are scoped to one course editor and reject malformed data', () => {
  const storage = memoryStorage();
  const payload = validPayload();
  const savedAt = writeTestEditorDraft(storage, 'new', payload, 1_750_000_000_000);
  assert.equal(savedAt, 1_750_000_000_000);
  assert.match(testEditorDraftStorageKey('new'), /^safetyhub:course-editor-draft:v2:/);
  assert.deepEqual(readTestEditorDraft(storage, 'new')?.test, payload);
  assert.equal(readTestEditorDraft(storage, 'another-editor'), null);
  assert.equal(parseTestEditorDraft('{broken', 'new'), null);
  assert.equal(parseTestEditorDraft('x'.repeat(1_000_001), 'new'), null);

  clearTestEditorDraft(storage, 'new');
  assert.equal(readTestEditorDraft(storage, 'new'), null);
});

test('course editor exposes presentation, policy, three variants, stable ids and canonical routes', async () => {
  const [component, actionBar, presentationInput, adminServer] = await Promise.all([
    read('components/admin/test-editor.tsx'),
    read('components/admin/editor-action-bar.tsx'),
    read('components/admin/course-presentation-input.tsx'),
    read('features/admin/server.ts'),
  ]);
  assert.match(component, /<CoursePresentationInput/);
  assert.match(component, /Вариант \{variant\.variantNumber\}/);
  assert.match(component, /Array\.from\(\{ length: TEST_EDITOR_LIMITS\.optionCount \}/);
  assert.match(component, /correctOptionId/);
  assert.match(component, /crypto\.randomUUID\(\)/);
  assert.match(component, /30 заполненных вопросов/);
  assert.match(component, /attemptResetTimezone: 'Asia\/Oral'/);
  assert.match(component, /clientRequest\('\/api\/admin\/courses'/);
  assert.match(component, /router\.replace\(`\/admin\/courses\//);
  assert.match(component, /writeTestEditorDraft\(/);
  assert.match(component, /useUnsavedChangesGuard\(dirty\)/);
  assert.match(component, /<EditorActionBar/);
  assert.match(component, /7\. Проверка перед публикацией/);
  assert.match(component, /8\. История редакций/);
  assert.match(component, /Это предупреждение не блокирует публикацию/);
  assert.match(component, /course\.revisionHistory\.map/);
  assert.match(component, /formatDateTime\(revision\.publishedAt, 'ru-RU'\)/);
  assert.doesNotMatch(component, /revision\.publishedAt\)\.toLocaleString/);
  assert.match(adminServer, /\.from\('test_revisions'\)[\s\S]*\.order\('version'/);
  assert.match(actionBar, /max-h-16/);
  assert.match(presentationInput, /import\('pdfjs-dist'\)/);
  assert.match(presentationInput, /new tus\.Upload/);
  assert.match(presentationInput, /headers: \{ 'x-signature': destination\.token \}/);
});

test('browser and server validation share the strict 3 x 10 x 4 limits', async () => {
  const schema = await read('lib/validation/admin.ts');
  assert.match(schema, /TEST_EDITOR_LIMITS\.questionTextMin/);
  assert.match(schema, /length\(TEST_EDITOR_LIMITS\.optionCount\)/);
  assert.match(schema, /length\(TEST_EDITOR_LIMITS\.questionCount\)/);
  assert.match(schema, /length\(TEST_EDITOR_LIMITS\.variantCount\)/);
  assert.match(schema, /export const testQuestionSchema/);
  assert.match(schema, /duplicateIds/);
});
