import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const overlay = await read('components/admin/admin-overlay.tsx');
const styles = await read('app/globals.css');

test('overlays render outside the query container', async () => {
  // `container-type: inline-size` applies layout containment, which by
  // specification makes the element a containing block for `position: fixed`
  // descendants. Chromium currently does not honour that, but the admin header
  // and dock carry `backdrop-filter`, which provably does — so nothing that has
  // to cover the viewport may depend on where it happens to sit in the tree.
  assert.match(overlay, /createPortal\(children, document\.body\)/u);
  assert.match(overlay, /const \[mounted, setMounted\] = useState\(false\)/u);

  for (const file of [
    'components/admin/destructive-dialog.tsx',
    'components/admin/attestations-filter-form.tsx',
    'components/admin/admin-notification-inbox.tsx',
    'components/profile/avatar-uploader.tsx',
  ]) {
    assert.match(await read(file), /AdminOverlay/u, `${file} must lift its overlay out`);
  }
  // The employee card and its action confirmation use the browser top layer.
  for (const file of ['components/admin/attestations-manager-panels.tsx', 'components/admin/attestations-action-dialog.tsx']) {
    const source = await read(file);
    assert.match(source, /<dialog/u);
    assert.match(source, /\.showModal\(\)/u);
  }
});

test('the destructive confirmation freezes the page behind it', () => {
  // Every other modal in the product locked scrolling; the one that deletes
  // records permanently did not, so the page moved under the dialog.
  assert.match(overlay, /document\.body\.style\.overflow = 'hidden'/u);
  assert.match(overlay, /lockScroll = true/u);
});

test('stacking order is declared once', async () => {
  for (const token of [
    '--z-sticky',
    '--z-header',
    '--z-overlay',
    '--z-install-prompt',
    '--z-skip-link',
    '--z-popover',
    '--z-dialog',
    '--z-camera',
  ]) {
    assert.match(styles, new RegExp(`${token}:`), `${token} is missing from the scale`);
  }
  const dialog = await read('components/admin/destructive-dialog.tsx');
  assert.match(dialog, /z-\[var\(--z-dialog\)\]/u);
  assert.doesNotMatch(dialog, /z-\[100\]/u);
});

test('desktop sticky rails clear the mobile chrome that is still on screen', async () => {
  const manager = await read('components/admin/attestations-manager.tsx');
  const actionBar = await read('components/admin/editor-action-bar.tsx');

  // The table switches to its desktop form by container width — about 808 px of
  // viewport — while the mobile header and dock only disappear at 1024 px. In
  // between, both were on screen and the desktop rails sat underneath them.
  assert.match(
    manager,
    /sticky bottom-\[calc\(var\(--mobile-tab-height\)\+var\(--safe-area-bottom\)\+1rem\)\][\s\S]*lg:bottom-4/u,
  );
  assert.match(manager, /sticky top-\[calc\(3\.5rem\+var\(--safe-area-top\)\)\][\s\S]*lg:top-0/u);
  // A hidden overflow on the sheet made it the header's scroll container, so
  // the 3.5rem offset pushed the header down over the first company band.
  assert.match(manager, /role="table"[\s\S]{0,600}@min-\[760px\]:overflow-clip/u);
  assert.doesNotMatch(manager, /role="table"[\s\S]{0,600}@min-\[760px\]:overflow-hidden/u);
  assert.match(actionBar, /lg:top-4/u);
});

test('the dock reserve is released exactly when the dock disappears', () => {
  // The reserve was dropped at 1440 px although the dock goes at 1024 px, so
  // between them the page kept four rem of empty space below the footer.
  const reserve = styles.slice(styles.indexOf('--mobile-fixed-bottom-space: 0px') - 200);
  assert.doesNotMatch(styles, /@media \(min-width: 1440px\)/u);
  assert.match(reserve, /@media \(min-width: 1024px\)/u);
});

test('the notification panel returns focus to the bell', async () => {
  const inbox = await read('components/admin/admin-notification-inbox.tsx');
  assert.match(inbox, /panelRef\.current\?\.focus\(\)/u);
  assert.match(inbox, /const trigger = triggerRef\.current;/u);
  assert.match(inbox, /trigger\?\.focus\(\)/u);
  // Only the mobile placement escapes the header; the desktop popover is
  // anchored to its sidebar entry and must stay there.
  assert.match(inbox, /NotificationPanelHost portal=\{placement !== 'desktop'\}/u);
});
