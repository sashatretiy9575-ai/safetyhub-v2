import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ContentSourceError,
  classifyContentFailure,
  fallbackAfterContentFailure,
  fallbackForUnavailableLocalizedContent,
  isContentFallbackEnabled,
  isContentTransportError,
} from '../../lib/content/fallback-policy.ts';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('public navigation uses one clear neutral account link on every surface', async () => {
  const [layout, publicAccountControl] = await Promise.all([
    read('app/(public)/layout.tsx'),
    read('components/shared/public-account-control.tsx'),
  ]);
  const header = await read('components/layout/header.tsx');
  const bottom = await read('components/layout/bottom-tab-bar.tsx');
  const navigationItems = await read('components/layout/navigation-items.ts');

  assert.match(
    layout,
    /<AppShell\s+accountMode="neutral"\s+accountControl=\{<PublicAccountControl\s*\/>\}/u,
  );
  assert.match(publicAccountControl, /safetyhub-session-hint=1/u);
  assert.doesNotMatch(publicAccountControl, /fetch\(|supabase|createClient|getAuthContext/iu);
  assert.match(publicAccountControl, /DeferredSignOutAction/u);
  assert.match(
    navigationItems,
    /neutral: \{ href: ROUTES\.profile, messageKey: 'account\.neutral' \}/,
  );
  assert.match(navigationItems, /guest: \{ href: ROUTES\.signIn, messageKey: 'account\.guest' \}/);
  assert.match(navigationItems, /messageKey: 'account\.authenticated'/);
  for (const source of [header, bottom]) {
    assert.match(source, /ACCOUNT_NAV_ITEMS\[accountMode\]/);
    assert.doesNotMatch(source, /Кабинет/);
  }
  assert.doesNotMatch(header, /MobileNav/);
  assert.match(header, /translations\(accountItem\.messageKey\)/);
  assert.match(header, /accountMode === 'authenticated' \? \(\s*accountMenu\s*\)/);
  const userMenu = await read('components/shared/user-menu.tsx');
  assert.doesNotMatch(userMenu, />\{email\}<\/p>/);
  assert.match(userMenu, /isAdmin \? translations\('admin'\) : translations\('profile'\)/u);
  assert.match(userMenu, /localizePathname\(ROUTES\.profile, locale\)/u);
  assert.doesNotMatch(layout, /getAuthContext|createClient|supabase/iu);
});

test('fallback flag is explicit', () => {
  const previous = process.env.CONTENT_FALLBACK_ENABLED;
  delete process.env.CONTENT_FALLBACK_ENABLED;
  try {
    assert.equal(isContentFallbackEnabled(), false);
    assert.equal(isContentFallbackEnabled('false'), false);
    assert.equal(isContentFallbackEnabled('1'), false);
    assert.equal(isContentFallbackEnabled(' TRUE '), true);
  } finally {
    if (previous === undefined) delete process.env.CONTENT_FALLBACK_ENABLED;
    else process.env.CONTENT_FALLBACK_ENABLED = previous;
  }
});

test('successful remote responses stay authoritative even when they contain zero rows', () => {
  assert.deepEqual(
    classifyContentFailure({ configured: true, error: null, fallbackEnabled: true }),
    { action: 'remote' },
  );
});

test('missing configuration and opted-in transport failure use bundled content', () => {
  assert.deepEqual(classifyContentFailure({ configured: false }), {
    action: 'fallback',
    reason: 'unconfigured',
  });
  assert.deepEqual(
    classifyContentFailure({
      configured: true,
      error: { message: 'FetchError: request failed' },
      fallbackEnabled: true,
      status: 0,
    }),
    { action: 'fallback', reason: 'transport' },
  );
  assert.equal(isContentTransportError(new TypeError('fetch failed')), true);
  assert.equal(isContentTransportError(new Error('bad mapping')), false);
  assert.deepEqual(
    classifyContentFailure({
      configured: true,
      error: { code: 'PGRST200', message: 'new relationship is not in the schema cache yet' },
      status: 400,
    }),
    { action: 'fallback', reason: 'unconfigured' },
  );
});

test('transport failures require degraded mode and backend errors are never masked', () => {
  assert.deepEqual(
    classifyContentFailure({
      configured: true,
      error: { message: 'fetch failed' },
      fallbackEnabled: false,
      status: 0,
    }),
    { action: 'throw', reason: 'transport-disabled' },
  );
  assert.deepEqual(
    classifyContentFailure({
      configured: true,
      error: { code: '42P01', message: 'relation does not exist' },
      fallbackEnabled: true,
      status: 500,
    }),
    { action: 'throw', reason: 'backend' },
  );

  assert.throws(
    () =>
      fallbackAfterContentFailure({
        configured: true,
        error: { code: '42501', message: 'permission denied' },
        fallback: () => ['local'],
        operation: 'test backend failure',
        status: 403,
      }),
    (error) => error instanceof ContentSourceError && error.failure === 'backend',
  );
});

test('content readers preserve empty and not-found remote results', async () => {
  for (const file of ['lib/content/articles.ts', 'lib/content/topics.ts']) {
    const source = await read(file);
    assert.doesNotMatch(source, /error\s*\|\|\s*!data/);
    assert.doesNotMatch(source, /!data\?\.length/);
    assert.match(source, /\(data \?\? \[\]\)\.map/);
    assert.match(source, /if \(!data\)\s*\{[\s\S]{0,160}?return null;/);
  }
});

test('localized public content never relabels the bundled Russian snapshot', async () => {
  assert.equal(
    fallbackForUnavailableLocalizedContent(
      'ru',
      () => 'russian snapshot',
      () => 'unavailable',
    ),
    'russian snapshot',
  );
  for (const locale of ['kk', 'en', 'zh']) {
    let russianFallbackCalls = 0;
    assert.equal(
      fallbackForUnavailableLocalizedContent(
        locale,
        () => {
          russianFallbackCalls += 1;
          return 'russian snapshot';
        },
        () => 'unavailable',
      ),
      'unavailable',
      locale,
    );
    assert.equal(russianFallbackCalls, 0, locale);
  }

  const [articles, topics] = await Promise.all([
    read('lib/content/articles.ts'),
    read('lib/content/topics.ts'),
  ]);
  for (const source of [articles, topics]) {
    assert.equal(
      (source.match(/fallbackForUnavailableLocalizedContent\(\s*locale/gu) ?? []).length,
      2,
    );
  }
  assert.match(articles, /value\.locale !== locale/u);
  assert.match(topics, /if \(value\.locale !== locale\) return null;/u);
});
