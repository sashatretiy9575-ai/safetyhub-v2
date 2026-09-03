import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function flatten(value, prefix = '', result = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) flatten(child, path, result);
    else result.set(path, child);
  }
  return result;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)(?:\s*,|\})/gu)]
    .map((match) => match[1])
    .sort();
}

test('all locale catalogs have identical non-empty typed keys and ICU parameters', async () => {
  const catalogs = Object.fromEntries(
    await Promise.all(
      ['ru', 'kk', 'en', 'zh'].map(async (locale) => [
        locale,
        JSON.parse(await read(`messages/${locale}.json`)),
      ]),
    ),
  );
  const reference = flatten(catalogs.ru);

  for (const [locale, catalog] of Object.entries(catalogs)) {
    const candidate = flatten(catalog);
    assert.deepEqual([...candidate.keys()].sort(), [...reference.keys()].sort(), locale);
    for (const [key, value] of candidate) {
      assert.equal(typeof value, 'string', `${locale}:${key}`);
      assert.ok(value.trim().length > 0, `${locale}:${key}`);
      assert.deepEqual(placeholders(value), placeholders(reference.get(key)), `${locale}:${key}`);
    }
  }
});

test('global error ships a minimal four-locale catalog instead of every learner message', async () => {
  const source = await read('app/global-error.tsx');
  assert.doesNotMatch(source, /@\/messages\/(?:ru|kk|en|zh)\.json/u);
  assert.match(source, /@\/messages\/global-error\/ru\.json/u);

  const expectedKeys = [
    'AppState.criticalDescription',
    'AppState.criticalTitle',
    'AppState.digestId',
    'Common.correlationIdPlain',
    'Common.home',
    'Common.retry',
  ];
  for (const locale of ['ru', 'kk', 'en', 'zh']) {
    const catalog = JSON.parse(await read(`messages/global-error/${locale}.json`));
    assert.deepEqual([...flatten(catalog).keys()].sort(), expectedKeys, locale);
  }
});

test('locale-aware PWA resources are precached and Chinese font loading is route-scoped', async () => {
  const [worker, rootDocument, styles, manifestRoute, offlineRoute, subsetScript] =
    await Promise.all([
      read('public/sw.js'),
      read('components/layout/root-document.tsx'),
      read('app/globals.css'),
      read('app/manifest/[locale]/route.ts'),
      read('app/offline/[locale]/route.ts'),
      read('scripts/subset-cjk-ui-font.py'),
    ]);
  const font = await stat(
    new URL('../../public/fonts/noto-sans-sc-ui.f113fe63.woff2', import.meta.url),
  );

  assert.match(worker, /OFFLINE_URLS/u);
  assert.match(worker, /offlineUrlForPathname/u);
  assert.match(worker, /Object\.keys\(OFFLINE_URLS\).*`\/manifest\/\$\{locale\}`/su);
  assert.match(worker, /CACHE_PREFIX\}v8/u);
  assert.match(rootDocument, /locale === 'zh'/u);
  assert.match(rootDocument, /\/fonts\/noto-sans-sc-ui\.f113fe63\.woff2/u);
  assert.match(styles, /html\[data-locale='zh'\]/u);
  assert.match(styles, /format\('woff2'\)/u);
  assert.match(subsetScript, /--flavor=woff2/u);
  assert.match(subsetScript, /hashlib\.sha256/u);
  assert.match(manifestRoute, /application\/manifest\+json/u);
  assert.match(offlineRoute, /text\/html; charset=utf-8/u);
  assert.ok(font.size > 20_000 && font.size < 500_000, `unexpected CJK UI font size: ${font.size}`);
});

test('sitemap expands canonical paths only when locale rollout is enabled', async () => {
  const sitemap = await read('app/sitemap.ts');
  assert.match(sitemap, /rolloutFeatureEnabled\('localeRoutes'\) \? APP_LOCALES/u);
  assert.match(sitemap, /return locales\.map/u);
  assert.match(sitemap, /localeAlternates\(input\.path\)/u);
  assert.match(sitemap, /localizePathname\(input\.path, locale\)/u);
  assert.match(sitemap, /alternates: \{ languages \}/u);
});

test('shared learner chrome contains no embedded Cyrillic copy outside catalogs', async () => {
  const shellFiles = [
    'components/layout/app-shell.tsx',
    'components/layout/header.tsx',
    'components/layout/header-nav.tsx',
    'components/layout/footer.tsx',
    'components/layout/bottom-tab-bar.tsx',
    'components/layout/navigation-items.ts',
    'components/layout/language-switcher.tsx',
    'components/shared/theme-toggle.tsx',
    'components/shared/pwa-install-overlay.tsx',
    'components/shared/user-menu.tsx',
  ];
  for (const file of shellFiles) {
    assert.doesNotMatch(await read(file), /[\u0400-\u04ff]/u, file);
  }
});
