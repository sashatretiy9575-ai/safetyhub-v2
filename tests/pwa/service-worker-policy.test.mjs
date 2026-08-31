import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('runtime cache is bounded, aged, quota-safe, and excludes hashed Next chunks', async () => {
  const [worker, config] = await Promise.all([read('public/sw.js'), read('next.config.ts')]);

  assert.match(worker, /safetyhub-static-/);
  assert.match(worker, /RUNTIME_MAX_ENTRIES = 48/);
  assert.match(worker, /RUNTIME_MAX_AGE_MS/);
  assert.match(worker, /trimRuntimeCache/);
  assert.match(worker, /catch \{[\s\S]*Quota pressure/);
  assert.doesNotMatch(worker, /STATIC_PREFIXES = \[[^\]]*\/_next\/static/);
  assert.match(worker, /key\.startsWith\(CACHE_PREFIX\) && key !== CACHE_VERSION/);
  assert.match(config, /source: '\/sw\.js'/u);
  assert.match(config, /Service-Worker-Allowed/u);
  assert.match(config, /no-cache, no-store, must-revalidate/u);
});

test('navigation preload and a bounded network race provide a deterministic offline fallback', async () => {
  const worker = await read('public/sw.js');

  assert.match(worker, /navigationPreload\?\.enable\(\)/);
  assert.match(worker, /NAVIGATION_TIMEOUT_MS = 6000/);
  assert.match(worker, /Promise\.race\(\[network, timeout\]\)/);
  assert.match(worker, /event\.preloadResponse/);
  assert.match(worker, /caches\.match\(OFFLINE_URL\)/);
  assert.match(worker, /event\.waitUntil\(network/);
});

test('authenticated navigations and generated downloads bypass the service worker', async () => {
  const worker = await read('public/sw.js');
  const callbackPassThrough = worker.indexOf(
    "if (request.mode === 'navigate' && isAuthCallbackPath(url.pathname))",
  );
  const privateBypass = worker.indexOf('if (isPrivatePath(url.pathname)) return;');
  const navigationHandler = worker.indexOf("if (request.mode === 'navigate')");

  assert.ok(callbackPassThrough >= 0 && callbackPassThrough < privateBypass);
  assert.ok(privateBypass >= 0 && privateBypass < navigationHandler);
  assert.match(worker, /\(\?:api\|auth\|admin\|profile\|account\|onboarding\|callback\)/u);
  assert.match(worker, /topics\\\/\[\^\/\]\+\\\/test/u);
  assert.match(worker, /CACHE_PREFIX\}v6/u);
});

test('signup callbacks consume navigation preload while recovery no longer navigates from email', async () => {
  const [worker, register, recovery, authCallback] = await Promise.all([
    read('public/sw.js'),
    read('app/api/auth/register/route.ts'),
    read('app/api/auth/password/recovery/route.ts'),
    read('app/(account)/auth/callback/route.ts'),
  ]);

  assert.match(register, /\/auth\/callback\?next=\/onboarding/u);
  assert.doesNotMatch(recovery, /\/auth\/callback|password_ticket|redirectTo/u);
  assert.match(authCallback, /export \{ GET \} from '\.\.\/\.\.\/callback\/route'/u);
  assert.match(worker, /AUTH_CALLBACK_PATH/u);
  assert.match(worker, /event\.respondWith\(authCallbackResponse\(event\)\)/u);
  assert.match(worker, /preloaded \|\| fetch\(event\.request\)/u);
});

test('offline action, splash, shortcuts, and automatic install prompt match their real context', async () => {
  const [offline, manifestSource, overlay] = await Promise.all([
    read('public/offline.html'),
    read('public/manifest.json'),
    read('components/shared/pwa-install-overlay.tsx'),
  ]);
  const manifest = JSON.parse(manifestSource);

  assert.match(offline, />На главную<\/a>/);
  assert.doesNotMatch(offline, />Повторить<\/a>/);
  assert.equal(manifest.background_color, '#f7f8fa');
  assert.equal(manifest.lang, 'ru-KZ');
  assert.equal(manifest.orientation, undefined);
  assert.equal(manifest.icons.find((icon) => icon.purpose === 'maskable')?.sizes, '512x512');
  assert.deepEqual(
    manifest.screenshots.map(({ src, sizes, form_factor: formFactor }) => ({
      src,
      sizes,
      formFactor,
    })),
    [
      {
        src: '/screenshots/safetyhub-mobile.png',
        sizes: '390x844',
        formFactor: 'narrow',
      },
      {
        src: '/screenshots/safetyhub-wide.png',
        sizes: '1280x720',
        formFactor: 'wide',
      },
    ],
  );
  assert.deepEqual(
    manifest.shortcuts.map((shortcut) => shortcut.url),
    ['/topics', '/blog', '/profile'],
  );
  assert.match(overlay, /isInstallable/);
  assert.match(overlay, /routeAllowsAutomaticPrompt/);
  assert.match(overlay, /alreadyShownThisSession/);
  assert.doesNotMatch(overlay, /getIOSBrowser/);
});

test('manual installation remains available without beforeinstallprompt and explains iOS', async () => {
  const [manual, menu, profile] = await Promise.all([
    read('components/shared/pwa-manual-install.tsx'),
    read('components/shared/user-menu.tsx'),
    read('app/(account)/profile/page.tsx'),
  ]);

  assert.match(manual, /if \(!isInstallable\)/);
  assert.match(manual, /Откройте SafetyHub в Safari/);
  assert.match(manual, /На экран Домой/);
  assert.match(manual, /Установить приложение/);
  assert.match(menu, /Установить приложение/);
  assert.match(menu, /#install-app/);
  assert.match(profile, /<PwaManualInstall \/>/);
});
