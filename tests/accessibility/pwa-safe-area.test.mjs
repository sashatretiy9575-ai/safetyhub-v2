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
  assert.match(layout, /pb-\[var\(--mobile-fixed-bottom-space\)\]/);
  assert.match(header, /pt-\[var\(--safe-area-top\)\]/);
  assert.match(header, /var\(--safe-area-left\)/);
  assert.match(tabs, /bottom-\[var\(--safe-area-bottom\)\]/);
  assert.match(tabs, /min-\[1024px\]:hidden/);
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
  // The banner is docked onto the mobile tab bar, not floated above it.
  assert.match(
    overlay,
    /bottom-\[calc\(var\(--safe-area-bottom\)\+var\(--mobile-tab-height\)\)\]/,
  );
  assert.match(overlay, /max-w-\[32\.5rem\]/);
  // The dismissal, session cap and delay must stay wired up.
  assert.match(overlay, /setIsDismissed\(hasActiveDismissal\(\) \|\| alreadyShownThisSession\(\)\)/);
  assert.doesNotMatch(overlay, /void hasActiveDismissal/);
  assert.match(overlay, /--pwa-banner-space/);
  assert.match(overlay, /PROMPT_DELAY_MS = 15_000/);
  assert.match(overlay, /30 \* 24 \* 60 \* 60/);
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
