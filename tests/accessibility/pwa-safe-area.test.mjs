import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('shared safe-area tokens drive the header and mobile tab reserve', async () => {
  const [css, layout, header, tabs] = await Promise.all([
    read('app/globals.css'),
    read('components/layout/app-shell.tsx'),
    read('components/layout/header.tsx'),
    read('components/layout/bottom-tab-bar.tsx'),
  ]);

  assert.match(css, /@theme[\s\S]*--safe-area-top:\s*env\(safe-area-inset-top, 0px\)/);
  assert.match(css, /--mobile-fixed-bottom-space:/);
  // The install banner overlays the bottom of the page, so the reserve now
  // covers the dock and the banner together, below the footer rather than
  // inside <main> where the banner simply covered the footer.
  assert.match(
    layout,
    /pb-\[calc\(var\(--mobile-fixed-bottom-space\)\+var\(--pwa-banner-space,0px\)\)\]/,
  );
  assert.match(header, /pt-\[var\(--safe-area-top\)\]/);
  assert.match(header, /var\(--safe-area-left\)/);
  assert.match(tabs, /bottom-\[var\(--safe-area-bottom\)\]/);
  assert.match(tabs, /lg:hidden/);
});

test('deferred install banner stays compact above the mobile bar and reserves temporary space', async () => {
  const [rootDocument, publicLayout, deferredInstall, installSurface, overlay] = await Promise.all([
    read('components/layout/root-document.tsx'),
    read('app/(public)/layout.tsx'),
    read('components/shared/deferred-pwa-install.tsx'),
    read('components/shared/pwa-install-surface.tsx'),
    read('components/shared/pwa-install-overlay.tsx'),
  ]);

  assert.doesNotMatch(rootDocument, /PWAInstallOverlay|PWAProvider/);
  assert.match(publicLayout, /<DeferredPwaInstall \/>/);
  assert.match(deferredInstall, /ssr: false/);
  assert.match(installSurface, /<PWAProvider>/);
  assert.match(installSurface, /<PWAInstallOverlay \/>/);
  // The card floats 5 px above the mobile tab bar, rounded on every side, and
  // is read against the dock's insets and width.
  assert.match(
    overlay,
    /bottom-\[calc\(var\(--safe-area-bottom\)\+var\(--pwa-dock-offset\)\+5px\)\]/,
  );
  assert.match(overlay, /rounded-\[var\(--radius-dock\)\] border /);
  assert.match(overlay, /max-w-\[32\.5rem\]/);
  // No delay, session cap or stored dismissal: the owner wants the card on
  // every phone visit until the app is installed.
  assert.doesNotMatch(overlay, /hasActiveDismissal|alreadyShownThisSession|PROMPT_DELAY_MS/);
  assert.match(overlay, /--pwa-banner-space/);
  assert.match(overlay, /splitLocalePathname\(pathname\)\.pathname/);
  assert.match(overlay, /routePathname\.startsWith\('\/admin'\)/);
  assert.match(overlay, /pointer: coarse/);
  assert.match(overlay, /var\(--safe-area-right\)/);
  assert.match(overlay, /var\(--safe-area-left\)/);
});

test('root documents stay free of mobile navigation space while the shared app shell reserves it', async () => {
  const [rootDocument, appShell, footer] = await Promise.all([
    read('components/layout/root-document.tsx'),
    read('components/layout/app-shell.tsx'),
    read('components/layout/footer.tsx'),
  ]);

  assert.doesNotMatch(rootDocument, /mobile-fixed-bottom-space/);
  assert.match(appShell, /mobile-fixed-bottom-space/);
  assert.doesNotMatch(footer, /pb-20/);
});
