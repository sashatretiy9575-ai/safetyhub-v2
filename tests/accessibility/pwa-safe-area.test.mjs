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
  assert.match(tabs, /min-\[1120px\]:hidden/);
});

test('install banner stays compact above the mobile bar and reserves temporary space', async () => {
  const [rootLayout, publicLayout, overlay] = await Promise.all([
    read('app/layout.tsx'),
    read('app/(public)/layout.tsx'),
    read('components/shared/pwa-install-overlay.tsx'),
  ]);

  assert.doesNotMatch(rootLayout, /PWAInstallOverlay|PWAProvider/);
  assert.match(publicLayout, /<PWAProvider>/);
  assert.match(publicLayout, /<PWAInstallOverlay \/>/);
  assert.match(overlay, /bottom-\[calc\(var\(--mobile-fixed-bottom-space\)\+\.5rem\)\]/);
  assert.match(overlay, /--pwa-banner-space/);
  assert.match(overlay, /PROMPT_DELAY_MS = 15_000/);
  assert.match(overlay, /30 \* 24 \* 60 \* 60/);
  assert.match(overlay, /splitLocalePathname\(pathname\)\.pathname/);
  assert.match(overlay, /routePathname\.startsWith\('\/admin'\)/);
  assert.match(overlay, /pointer: coarse/);
  assert.match(overlay, /var\(--safe-area-right\)/);
  assert.match(overlay, /var\(--safe-area-left\)/);
});

test('only the public shell reserves space for its fixed mobile navigation', async () => {
  const [layout, appShell, footer] = await Promise.all([
    read('app/layout.tsx'),
    read('components/layout/app-shell.tsx'),
    read('components/layout/footer.tsx'),
  ]);

  assert.doesNotMatch(layout, /mobile-fixed-bottom-space/);
  assert.match(appShell, /mobile-fixed-bottom-space/);
  assert.doesNotMatch(footer, /pb-20/);
});
