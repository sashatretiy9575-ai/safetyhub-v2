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

test('the card is offered on touch screens up to a landscape tablet, never on a desktop', () => {
  // The owner's decision (September 2026): phones and tablets in either
  // orientation, nothing with a mouse. The pointer test keeps a narrow desktop
  // window out; the width cap ends at the widest tablet in landscape.
  assert.match(overlay, /\(max-width: 1366px\) and \(pointer: coarse\)/u);
  assert.doesNotMatch(overlay, /max-width: (?:899|1023)px/u);
});

test('the card and its reserve follow the dock offset, which is zero once the dock hides', async () => {
  // Above 1023 px the dock is gone but the card still shows on a landscape
  // tablet, so its bottom offset and the footer reserve read one variable that
  // the stylesheet zeroes at the same breakpoint.
  const css = await read('app/globals.css');
  assert.match(
    overlay,
    /bottom-\[calc\(var\(--safe-area-bottom\)\+var\(--pwa-dock-offset\)\+5px\)\]/u,
  );
  assert.match(css, /--pwa-dock-offset: var\(--mobile-tab-height\);/u);
  assert.match(css, /--pwa-dock-offset: 0px;/u);
  assert.match(shell, /min-\[1024px\]:pb-\[var\(--pwa-banner-space,0px\)\]/u);
  assert.doesNotMatch(shell, /min-\[1024px\]:pb-0/u);
});

test('the button label never depends on whether the browser has fired its install event', () => {
  // `beforeinstallprompt` arrives seconds after load. A label that read
  // "How to install" until then and "Install" afterwards changed under the
  // visitor's thumb on Android; now it reads "Install" until tapped.
  assert.doesNotMatch(overlay, /isInstallable\s*\?\s*translations\('install'\)/u);
  assert.match(
    overlay,
    /isInstalling \? translations\('installing'\) : translations\('install'\)/u,
  );
  assert.match(overlay, /if \(ios \|\| !isInstallable\) \{/u);
});

test('the copy is readable on a phone', () => {
  // 12 px body text and a 15 px title were too small to read on a phone.
  assert.doesNotMatch(overlay, /text-xs leading-relaxed/u);
  assert.match(overlay, /text-\[17px\] leading-tight font-bold/u);
  assert.match(overlay, /text-\[15px\] leading-normal/u);
});

test('visibility has no condition that decides nothing', () => {
  // `(isInstallable || !isStandalone)` was absorbed by the `!isStandalone`
  // beside it.
  assert.doesNotMatch(overlay, /\(isInstallable \|\| !isStandalone\)/u);
});

test('the reserved space matches the banner and clears the footer', () => {
  // 160 px was reserved for a banner at least 140 px tall that sits on top of
  // the dock inside the bottom safe area — and it was reserved on <main>, so the
  // banner covered the footer rather than clearing it. With the larger type the
  // card reaches about 180 px on a narrow phone, hence 12 rem.
  assert.match(overlay, /var\(--pwa-dock-offset\) \+ var\(--safe-area-bottom\) \+ 12rem/u);
  assert.doesNotMatch(shell, /<main[^>]*--pwa-banner-space/su);
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
