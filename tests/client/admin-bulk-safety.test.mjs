import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const manager = await read('components/admin/attestations-manager.tsx');

test('only the newest selection may decide what gets deleted', () => {
  // Two quick clicks on different companies raced. Whichever answer came back
  // last became the single source of `userIds`, so an operator could confirm a
  // deletion for a company they had already clicked away from — and the purge
  // is irreversible.
  assert.match(manager, /const requestId = selectionRequestRef\.current \+ 1;/u);
  assert.match(manager, /selectionAbortRef\.current\?\.abort\(\)/u);
  assert.match(manager, /if \(requestId !== selectionRequestRef\.current\) return null;/u);

  // The stale count must go before the new request starts: showing the previous
  // company's total beside a new company's name is how the wrong rows get
  // confirmed.
  const resolver = manager.slice(manager.indexOf('const resolveFilteredSelection'));
  const clearAt = resolver.indexOf('dropResolvedSelection(key)');
  const requestAt = resolver.indexOf("'/api/admin/attestations/selection'");
  assert.ok(clearAt > 0 && clearAt < requestAt, 'the previous selection is dropped up front');
});

test('a second click cannot start while a selection is resolving', () => {
  const disabled = manager.match(/disabled=\{selectingAll \|\| busy\}/gu) ?? [];
  assert.ok(disabled.length >= 2, 'the band checkbox and the rename button are guarded');
});

test('the rename dialog waits for the selection it will act on', () => {
  // It used to open immediately, announce "0 чел." and send a request the API
  // rejected as INVALID_REQUEST.
  assert.match(
    manager,
    /const selection = await setOrganizationGroupSelected\([\s\S]*?if \(!selection\) return;[\s\S]*?setPending\(\{ kind: 'bulk-update'/u,
  );
});

test('idempotency keys follow what they authorize', () => {
  // Keyed only on the chunk count, editing the reason and pressing delete again
  // replayed a key against a different request: the database refuses that, and
  // the panel had no way out of the refusal but a page reload.
  assert.match(manager, /const purgeSignature = `\$\{reason\}::\$\{userIds\.join\(','\)\}`/u);
  assert.match(manager, /purgeSignatureRef\.current !== purgeSignature/u);
  assert.match(manager, /payload\?\.error === 'IDEMPOTENCY_KEY_REUSED'/u);
});

test('a partial deletion reports what it did', async () => {
  // The earlier chunks had already deleted people. Reporting "nothing happened"
  // and leaving the list untouched invited the operator to delete them twice.
  assert.match(manager, /Обработано пачек: \$\{index\} из \$\{chunks\.length\}/u);
  assert.match(manager, /if \(items\.length > 0\) \{/u);

  const apiError = await read('server/auth/api-error.ts');
  // These codes are what the panel explains in its own words; the catch-all
  // below used to flatten them into PROTECTED_OPERATION.
  for (const code of ['IDEMPOTENCY_KEY_REUSED', 'LAST_ACTIVE_ADMIN_PROTECTED', 'CANNOT_DELETE_SELF']) {
    assert.ok(apiError.includes(`'${code}'`), `${code} loses its identity`);
  }
});

test('work started on the page stops when the page is left', () => {
  // The certificate worker kept rendering PDFs and finished by starting a
  // download on a screen the operator had already navigated away from.
  assert.match(manager, /exportAbortRef\.current\?\.abort\(\);\s*\n\s*exportAbortRef\.current = null;/u);
});

test('list rendering does not rebuild a formatter per cell', async () => {
  const row = await read('components/admin/attestation-table-row.tsx');
  const inbox = await read('components/admin/admin-notification-inbox.tsx');
  const utils = await read('lib/utils.ts');

  assert.match(row, /const COMPACT_DATE_TIME = new Intl\.DateTimeFormat/u);
  assert.match(inbox, /const NOTIFICATION_DATE_TIME = new Intl\.DateTimeFormat/u);
  assert.match(utils, /const dateTimeFormatters = new Map<string, Intl\.DateTimeFormat>/u);
  // Fifty rows with two dates each rebuilt a hundred formatters per keystroke.
  assert.doesNotMatch(row, /function compactDateTime[\s\S]{0,200}new Intl\.DateTimeFormat/u);
});

test('company similarity normalizes each name once', () => {
  // With 500 selected rows the inner loop repeated the same lowercasing and
  // regex a quarter of a million times, while the operator waited.
  assert.match(manager, /const normalized = orgs\.map\(\(org\) =>/u);
  assert.match(manager, /const normA = normalized\[i\] \?\? '';/u);
});

test('one unreadable notification does not blank the inbox', async () => {
  const inbox = await read('components/admin/admin-notification-inbox.tsx');
  assert.match(inbox, /\.filter\(\(event\): event is NonNullable<typeof event> => event !== null\)/u);
  assert.doesNotMatch(inbox, /if \(items\.some\(\(event\) => event === null\)\) return null;/u);
});
