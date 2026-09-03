import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isRouteActive, normalizeRoutePath } from '../../lib/navigation.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('route matching treats a section as active only on its own pages', () => {
  assert.equal(normalizeRoutePath('/topics/'), '/topics');
  assert.equal(normalizeRoutePath(''), '/');

  assert.equal(isRouteActive('/', '/'), true);
  assert.equal(isRouteActive('/topics', '/'), false);
  assert.equal(isRouteActive('/topics', '/topics'), true);
  assert.equal(isRouteActive('/topics/biot', '/topics'), true);
  assert.equal(isRouteActive('/contacts', '/topics'), false);
  // A sibling whose name merely starts the same must not match.
  assert.equal(isRouteActive('/topicsomething', '/topics'), false);
});

test('the mobile tab bar strips the language prefix before matching', async () => {
  const source = await read('components/layout/bottom-tab-bar.tsx');

  // Regression: comparing localized paths made "/kk" (the Kazakh home) a prefix
  // of every Kazakh page, so /kk/contacts lit both Home and Contacts at once.
  // Russian has no prefix, which is why the bug was invisible there.
  assert.match(source, /splitLocalePathname\(pathname \?\? '\/'\)\.pathname/u);
  assert.match(source, /isRouteActive\(routePathname, href\)/u);
  assert.doesNotMatch(source, /isRouteActive\(pathname, localizedHref\)/u);

  // The href passed to the matcher must be the unprefixed route constant, while
  // the rendered link keeps the localized one.
  assert.match(source, /href=\{localizedHref\}/u);

  for (const [current, target, expected] of [
    ['/kk/contacts', '/', false],
    ['/kk', '/', true],
    ['/en/topics/biot', '/topics', true],
    ['/en/topics/biot', '/', false],
    ['/zh/blog', '/blog', true],
    ['/zh/blog', '/contacts', false],
  ]) {
    // Mirrors what the component now does: split first, then match.
    const stripped = current.replace(/^\/(?:kk|en|zh)(?=\/|$)/u, '') || '/';
    assert.equal(isRouteActive(stripped, target), expected, `${current} vs ${target}`);
  }
});
