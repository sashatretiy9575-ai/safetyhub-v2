import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EDITOR_DRAFT_LIMIT,
  EDITOR_DRAFT_MAX_BYTES,
  clearEditorDraft,
  editorDraftStorageKey,
  readEditorDraft,
  writeEditorDraft,
} from '../../lib/editor-drafts.ts';

class MemoryStorage {
  #values = new Map();

  get length() {
    return this.#values.size;
  }

  clear() {
    this.#values.clear();
  }

  getItem(key) {
    return this.#values.get(key) ?? null;
  }

  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key) {
    this.#values.delete(key);
  }

  setItem(key, value) {
    this.#values.set(key, String(value));
  }
}

const isPayload = (value) =>
  Boolean(value && typeof value === 'object' && Array.isArray(value.modules));

test('the shared editor store restores nested payloads', () => {
  const storage = new MemoryStorage();
  const payload = {
    modules: [
      {
        lessons: [{ blocks: [{ type: 'paragraph', content: 'Сохранённый урок' }] }],
      },
    ],
    questions: [{ text: 'Вопрос' }],
  };

  assert.equal(writeEditorDraft(storage, 'course', 'course-1', payload, 100), 100);
  const restored = readEditorDraft(storage, 'course', 'course-1', isPayload);
  assert.deepEqual(restored?.payload, payload);
});

test('course and article drafts share one three-entry LRU budget', () => {
  const storage = new MemoryStorage();
  writeEditorDraft(storage, 'course', 'one', { modules: [] }, 100);
  writeEditorDraft(storage, 'article', 'two', { modules: [] }, 200);
  writeEditorDraft(storage, 'course', 'three', { modules: [] }, 300);
  writeEditorDraft(storage, 'article', 'four', { modules: [] }, 400);

  assert.equal(EDITOR_DRAFT_LIMIT, 3);
  assert.equal(storage.length, 3);
  assert.equal(storage.getItem(editorDraftStorageKey('course', 'one')), null);
  assert.ok(storage.getItem(editorDraftStorageKey('article', 'two')));
  assert.ok(storage.getItem(editorDraftStorageKey('course', 'three')));
  assert.ok(storage.getItem(editorDraftStorageKey('article', 'four')));
});

test('reading a draft refreshes its LRU position', () => {
  const storage = new MemoryStorage();
  writeEditorDraft(storage, 'course', 'one', { modules: [] }, 100);
  writeEditorDraft(storage, 'article', 'two', { modules: [] }, 200);
  writeEditorDraft(storage, 'course', 'three', { modules: [] }, 300);

  const restored = readEditorDraft(storage, 'course', 'one', isPayload, 400);
  assert.equal(restored?.savedAt, 400);
  writeEditorDraft(storage, 'article', 'four', { modules: [] }, 500);

  assert.ok(storage.getItem(editorDraftStorageKey('course', 'one')));
  assert.equal(storage.getItem(editorDraftStorageKey('article', 'two')), null);
  assert.ok(storage.getItem(editorDraftStorageKey('course', 'three')));
  assert.ok(storage.getItem(editorDraftStorageKey('article', 'four')));
});

test('incompatible and corrupt drafts are ignored without crashing', () => {
  const storage = new MemoryStorage();
  const key = editorDraftStorageKey('article', 'broken');
  storage.setItem(key, '{not json');
  assert.equal(readEditorDraft(storage, 'article', 'broken', isPayload), null);

  storage.setItem(
    key,
    JSON.stringify({ version: 99, kind: 'article', editorId: 'broken', savedAt: 100, payload: {} }),
  );
  assert.equal(readEditorDraft(storage, 'article', 'broken', isPayload), null);
  clearEditorDraft(storage, 'article', 'broken');
  assert.equal(storage.getItem(key), null);
});

test('the per-draft limit is measured in UTF-8 bytes', () => {
  const storage = new MemoryStorage();
  const oversizedCyrillic = { modules: [{ title: 'я'.repeat(EDITOR_DRAFT_MAX_BYTES / 2) }] };

  assert.equal(writeEditorDraft(storage, 'course', 'large', oversizedCyrillic, 500), null);
  assert.equal(storage.getItem(editorDraftStorageKey('course', 'large')), null);
});
