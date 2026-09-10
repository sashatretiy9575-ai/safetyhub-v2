import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

const overlay = await read('components/shared/pwa-install-overlay.tsx');
const shell = await read('components/layout/app-shell.tsx');

test('the banner shows on every phone visit until the app is installed', () => {
  // The owner's decision (September 2026): no delay, no once-per-session cap
  // and no thirty-day memory after a close. The card is `fixed`, so it does
  // not move the content it floats over; closing it hides it for that page
  // view only. Standalone launches, admin screens and a running test stay
  // free of it.
  assert.doesNotMatch(overlay, /PROMPT_DELAY_MS|localStorage|sessionStorage/u);
  assert.match(overlay, /const \[isDismissed, setIsDismissed\] = React\.useState\(false\)/u);
  assert.match(overlay, /!isStandalone/u);
  assert.match(overlay, /routeAllowsAutomaticPrompt\(pathname\)/u);
});

test('the phone test matches the range where the dock exists', () => {
  // The query stopped at 899 px and never asked about the pointer, although the
  // comment beside it claimed both. Between 900 and 1023 px the banner was
  // absent while the dock it sits on was present, and a narrow desktop window
  // was offered a phone install prompt.
  assert.match(overlay, /\(max-width: 1023px\) and \(pointer: coarse\)/u);
  assert.doesNotMatch(overlay, /max-width: 899px/u);
});

test('visibility has no condition that decides nothing', () => {
  // `(isInstallable || !isStandalone)` was absorbed by the `!isStandalone`
  // beside it.
  assert.doesNotMatch(overlay, /\(isInstallable \|\| !isStandalone\)/u);
});

test('the reserved space matches the banner and clears the footer', () => {
  // 160 px was reserved for a banner at least 140 px tall that sits on top of
  // the dock inside the bottom safe area — and it was reserved on <main>, so the
  // banner covered the footer rather than clearing it.
  assert.match(overlay, /var\(--mobile-tab-height\) \+ var\(--safe-area-bottom\) \+ 10\.25rem/u);
  assert.doesNotMatch(shell, /pb-\[var\(--pwa-banner-space,0px\)\]/u);
  assert.match(shell, /--pwa-banner-space,0px/u);
});

test('the install button never points at a route that does not exist', async () => {
  // `/install` has never existed. The redirect sent iOS and desktop Safari —
  // the browsers with no install prompt, that is, exactly the ones needing
  // instructions — to a 404.
  assert.doesNotMatch(overlay, /window\.location\.href = '\/install'/u);
  assert.match(overlay, /setShowInstructions\(true\)/u);
  assert.match(overlay, /instructions\.\$\{platform\}\.\$\{step\}/u);

  // And the menu entry for administrators now has a target to land on.
  const adminAccount = await read('app/(admin)/admin/account/page.tsx');
  assert.match(adminAccount, /<PwaManualInstall \/>/u);
});

test('one hook answers the install question for the whole page', async () => {
  const [menu, manual] = await Promise.all([
    read('components/shared/user-menu.tsx'),
    read('components/shared/pwa-manual-install.tsx'),
  ]);
  // Three components each ran their own copy, so three listeners answered one
  // browser event and could disagree about installability.
  for (const source of [overlay, menu, manual]) {
    assert.match(source, /usePWA\(\)/u);
    assert.doesNotMatch(source, /usePwaInstall\(\)/u);
  }
});

test('the private roots declare the viewport their layout depends on', async () => {
  const [account, admin, identity] = await Promise.all([
    read('app/(account)/layout.tsx'),
    read('app/(admin)/layout.tsx'),
    read('lib/pwa-identity.ts'),
  ]);
  // Neither declared one, so `viewportFit: 'cover'` never applied and every
  // safe-area rule on those screens was inert on a phone with a notch.
  for (const source of [account, admin]) {
    assert.match(source, /export const viewport: Viewport = APP_VIEWPORT;/u);
    assert.match(source, /\.\.\.pwaIdentity\(\)/u);
    // The identity block was copied four times and the copies had drifted.
    assert.doesNotMatch(source, /apple-touch-icon/u);
  }
  assert.match(identity, /viewportFit: 'cover'/u);
  assert.match(identity, /'apple-mobile-web-app-capable': 'yes'/u);
});
