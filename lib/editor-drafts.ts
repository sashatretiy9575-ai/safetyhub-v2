export const EDITOR_DRAFT_LIMIT = 3;
export const EDITOR_DRAFT_MAX_BYTES = 100_000;

export type EditorDraftKind = 'article' | 'course';

export type StoredEditorDraft<T> = Readonly<{
  version: 1;
  kind: EditorDraftKind;
  editorId: string;
  savedAt: number;
  payload: T;
}>;

const DRAFT_PREFIX = 'safetyhub:editor-draft:v1:';

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

export function editorDraftStorageKey(kind: EditorDraftKind, editorId: string) {
  return `${DRAFT_PREFIX}${kind}:${encodeURIComponent(editorId)}`;
}

function validSavedAt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 8_640_000_000_000_000;
}

function draftHeaders(storage: Storage) {
  const drafts: Array<{ key: string; savedAt: number }> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(DRAFT_PREFIX)) continue;
    try {
      const raw = storage.getItem(key);
      if (!raw || utf8ByteLength(raw) > EDITOR_DRAFT_MAX_BYTES) {
        storage.removeItem(key);
        continue;
      }
      const value = JSON.parse(raw) as Partial<StoredEditorDraft<unknown>>;
      if (value.version !== 1 || !validSavedAt(value.savedAt)) {
        storage.removeItem(key);
        continue;
      }
      drafts.push({ key, savedAt: value.savedAt });
    } catch {
      storage.removeItem(key);
    }
  }
  return drafts;
}

function pruneEditorDrafts(storage: Storage) {
  const drafts = draftHeaders(storage).sort(
    (left, right) => right.savedAt - left.savedAt || left.key.localeCompare(right.key),
  );
  for (const stale of drafts.slice(EDITOR_DRAFT_LIMIT)) storage.removeItem(stale.key);
}

export function readEditorDraft<T>(
  storage: Storage,
  kind: EditorDraftKind,
  editorId: string,
  validatePayload: (value: unknown) => value is T,
  accessedAt = Date.now(),
): StoredEditorDraft<T> | null {
  try {
    const raw = storage.getItem(editorDraftStorageKey(kind, editorId));
    if (!raw || utf8ByteLength(raw) > EDITOR_DRAFT_MAX_BYTES) return null;
    const value = JSON.parse(raw) as Partial<StoredEditorDraft<unknown>>;
    if (
      value.version !== 1 ||
      value.kind !== kind ||
      value.editorId !== editorId ||
      !validSavedAt(value.savedAt) ||
      !validatePayload(value.payload)
    ) {
      return null;
    }
    const restored = value as StoredEditorDraft<T>;
    const touched: StoredEditorDraft<T> = { ...restored, savedAt: accessedAt };
    const touchedAt = writeEditorDraft(storage, kind, editorId, restored.payload, accessedAt);
    return touchedAt === null ? restored : touched;
  } catch {
    return null;
  }
}

export function writeEditorDraft<T>(
  storage: Storage,
  kind: EditorDraftKind,
  editorId: string,
  payload: T,
  savedAt = Date.now(),
) {
  const value: StoredEditorDraft<T> = { version: 1, kind, editorId, savedAt, payload };
  try {
    const serialized = JSON.stringify(value);
    if (utf8ByteLength(serialized) > EDITOR_DRAFT_MAX_BYTES) return null;
    storage.setItem(editorDraftStorageKey(kind, editorId), serialized);
    pruneEditorDrafts(storage);
    return savedAt;
  } catch {
    return null;
  }
}

export function clearEditorDraft(storage: Storage, kind: EditorDraftKind, editorId: string) {
  try {
    storage.removeItem(editorDraftStorageKey(kind, editorId));
  } catch {
    // Storage can be unavailable in private or hardened browser contexts.
  }
}
