import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  APP_LOCALES,
  htmlLanguage,
  isLocaleRoutablePath,
  localeAlternates,
  localeFromAcceptLanguage,
  localizePathname,
  resolvePreferredLocale,
  splitLocalePathname,
} from '../../i18n/config.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the route contract keeps Russian unprefixed and round-trips supported locale paths', () => {
  assert.deepEqual(APP_LOCALES, ['ru', 'kk', 'en', 'zh']);
  assert.equal(htmlLanguage('ru'), 'ru-KZ');
  assert.equal(htmlLanguage('kk'), 'kk-KZ');
  assert.equal(htmlLanguage('en'), 'en');
  assert.equal(htmlLanguage('zh'), 'zh-Hans');

  for (const [locale, expected] of [
    ['ru', '/topics/fire-safety'],
    ['kk', '/kk/topics/fire-safety'],
    ['en', '/en/topics/fire-safety'],
    ['zh', '/zh/topics/fire-safety'],
  ]) {
    assert.equal(localizePathname('/topics/fire-safety', locale), expected);
    const split = splitLocalePathname(expected);
    assert.equal(split.locale, locale);
    assert.equal(split.pathname, '/topics/fire-safety');
  }

  assert.equal(localizePathname('/en/blog', 'ru'), '/blog');
  assert.equal(localizePathname('/ru/blog', 'ru'), '/blog');
  assert.deepEqual(splitLocalePathname('/ru/blog'), {
    locale: 'ru',
    pathname: '/blog',
    hasLocalePrefix: true,
  });
  assert.equal(localizePathname('/', 'zh'), '/zh');
});

test('admin, API, metadata and immutable assets never gain locale aliases', () => {
  for (const pathname of [
    '/admin',
    '/admin/approvals',
    '/api/profile',
    '/_next/static/app.js',
    '/icons/icon-192x192.png',
    '/images/hero.webp',
    '/fonts/manrope.woff2',
    '/course-presentations/course/file.pdf',
    '/manifest/zh',
    '/offline/zh',
    '/robots.txt',
    '/sitemap.xml',
    '/sw.js',
  ]) {
    assert.equal(isLocaleRoutablePath(pathname), false, pathname);
    assert.equal(localizePathname(pathname, 'zh'), pathname, pathname);
  }
  assert.equal(isLocaleRoutablePath('/topics'), true);
  assert.equal(isLocaleRoutablePath('/auth/login'), true);
});

test('explicit URL, cookie and weighted Accept-Language detection are deterministic', () => {
  assert.equal(localeFromAcceptLanguage('de-DE, zh-CN;q=0.9, en;q=0.8'), 'zh');
  assert.equal(localeFromAcceptLanguage('ru;q=0.4, kk-KZ;q=0.9'), 'kk');
  assert.equal(localeFromAcceptLanguage('fr-FR,*;q=0.5'), 'ru');
  assert.equal(
    resolvePreferredLocale({
      pathname: '/zh/topics',
      localeCookie: 'en',
      acceptLanguage: 'kk-KZ',
    }),
    'zh',
  );
  assert.equal(
    resolvePreferredLocale({ pathname: '/topics', localeCookie: 'en', acceptLanguage: 'kk-KZ' }),
    'en',
  );
  assert.equal(
    resolvePreferredLocale({
      pathname: '/topics',
      localeCookie: 'invalid',
      acceptLanguage: 'kk-KZ',
    }),
    'kk',
  );
});

test('metadata helpers emit localized canonical, hreflang and Open Graph contracts', async () => {
  const seo = await read('lib/seo.ts');
  assert.match(seo, /localizePathname\(normalizedPath \|\| '\/', locale\)/u);
  assert.match(seo, /alternates: \{ canonical: url, languages: languageAlternates \}/u);
  assert.match(seo, /locale: openGraphLocale\(locale\)/u);
  assert.deepEqual(localeAlternates('/blog'), {
    'ru-KZ': '/blog',
    'kk-KZ': '/kk/blog',
    en: '/en/blog',
    'zh-Hans': '/zh/blog',
    'x-default': '/blog',
  });
});

test('proxy composes locale routing ahead of the existing Supabase/CSP gate', async () => {
  const [proxy, switcher] = await Promise.all([
    read('proxy.ts'),
    read('components/layout/language-switcher.tsx'),
  ]);
  const publicFastPath = proxy.indexOf('if (!isProtected)');
  const refresh = proxy.indexOf('await updateSession');
  assert.ok(publicFastPath > 0 && refresh > publicFastPath);
  assert.match(proxy, /splitLocalePathname\(externalPathname\)/u);
  assert.match(proxy, /requestHeaders\.set\(LOCALE_HEADER_NAME, locale\)/u);
  assert.match(proxy, /NextResponse\.rewrite\(destination/u);
  assert.match(proxy, /localizedPath\.hasLocalePrefix && !localeRoutable/u);
  assert.match(proxy, /localizedPath\.locale === DEFAULT_LOCALE/u);
  assert.equal((proxy.match(/updateSession\(/gu) ?? []).length, 1);
  assert.match(switcher, /document\.cookie = `\$\{LOCALE_COOKIE_NAME\}/u);
  assert.match(switcher, /localizePathname\(pathname, nextLocale\)/u);
  assert.match(switcher, /window\.location\.search\.slice\(1\)/u);
  assert.match(switcher, /SameSite=Lax/u);
});
