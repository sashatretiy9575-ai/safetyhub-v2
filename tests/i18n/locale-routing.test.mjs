import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  APP_LOCALES,
  htmlLanguage,
  isLocaleRoutablePath,
  localeAlternates,
  localeFromAcceptLanguage,
  localesForLanguageSwitcher,
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

test('language switcher exposes only locale routes enabled for the active page', async () => {
  assert.deepEqual(
    localesForLanguageSwitcher({
      pathname: '/topics',
      localeRoutesEnabled: false,
      zhUsernamePasswordEnabled: false,
    }),
    ['ru'],
  );
  assert.deepEqual(
    localesForLanguageSwitcher({
      pathname: '/zh/auth/login',
      localeRoutesEnabled: true,
      zhUsernamePasswordEnabled: false,
    }),
    ['ru', 'kk', 'en'],
  );
  assert.deepEqual(
    localesForLanguageSwitcher({
      pathname: '/auth/register',
      localeRoutesEnabled: true,
      zhUsernamePasswordEnabled: true,
    }),
    APP_LOCALES,
  );
  assert.deepEqual(
    localesForLanguageSwitcher({
      pathname: '/topics',
      localeRoutesEnabled: true,
      zhUsernamePasswordEnabled: false,
    }),
    APP_LOCALES,
  );

  const [header, switcher, flags, deferredSwitcher] = await Promise.all([
    read('components/layout/header.tsx'),
    read('components/layout/language-switcher.tsx'),
    read('components/layout/locale-flag.tsx'),
    read('components/layout/deferred-language-switcher.tsx'),
  ]);
  assert.match(header, /localePathname/u);
  assert.match(
    header,
    /localesForLanguageSwitcher\(\{[\s\S]*?localeRoutesEnabled[\s\S]*?zhUsernamePasswordEnabled/u,
  );
  assert.match(header, /<DeferredLanguageSwitcher/u);
  assert.match(switcher, /locales:\s*readonly AppLocale\[\]/u);
  assert.match(switcher, /!locales\.includes\(nextLocale\)/u);
  assert.match(switcher, /\{locales\.map\(/u);
  assert.doesNotMatch(switcher, /\{APP_LOCALES\.map\(/u);
  assert.doesNotMatch(switcher, /<select\b/iu);
  assert.match(switcher, /DropdownMenuRadioGroup/u);
  assert.match(switcher, /DropdownMenuRadioItem/u);
  assert.match(switcher, /<LocaleFlag locale=\{candidate\}/u);
  assert.match(flags, /flag-icons\/flags\/4x3\/ru\.svg/u);
  assert.match(flags, /flag-icons\/flags\/4x3\/kz\.svg/u);
  assert.match(flags, /flag-icons\/flags\/4x3\/gb\.svg/u);
  assert.match(flags, /flag-icons\/flags\/4x3\/cn\.svg/u);
  assert.match(flags, /typeof asset === 'string' \? asset : asset\.src/u);
  assert.match(flags, /src=\{flagSource\(FLAG_ASSET\[locale\]\)\}/u);
  assert.match(deferredSwitcher, /LanguageSwitcherFallback/u);
  assert.match(deferredSwitcher, /<LocaleFlag locale=\{locale\}/u);
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
  const [
    proxy,
    switcher,
    requestConfig,
    publicLayout,
    localizedLayout,
    rootDocument,
    seo,
    privateLocale,
    accountLayout,
    loginPage,
  ] =
    await Promise.all([
      read('proxy.ts'),
      read('components/layout/language-switcher.tsx'),
      read('i18n/request.ts'),
      read('app/(public)/layout.tsx'),
      read('app/[locale]/layout.tsx'),
      read('components/layout/root-document.tsx'),
      read('lib/seo.ts'),
      read('i18n/private-request-locale.ts'),
      read('app/(account)/layout.tsx'),
      read('app/(account)/auth/login/page.tsx'),
    ]);
  const publicFastPath = proxy.indexOf('if (!isProtected && !isAuthEntry)');
  const refresh = proxy.indexOf('await updateSession');
  assert.ok(publicFastPath > 0 && refresh > publicFastPath);
  assert.match(proxy, /splitLocalePathname\(externalPathname\)/u);
  assert.match(proxy, /function isPhysicalLocaleRoute\(pathname: string\)/u);
  assert.match(proxy, /const physicalLocaleRoute =/u);
  assert.match(proxy, /renderPathname = physicalLocaleRoute \? externalPathname : pathname/u);
  assert.match(proxy, /s-maxage=300, stale-while-revalidate=86400/u);
  assert.match(proxy, /requestHeaders\.set\(LOCALE_HEADER_NAME, locale\)/u);
  assert.match(proxy, /NextResponse\.rewrite\(destination/u);
  assert.match(proxy, /localizedPath\.hasLocalePrefix && !localeRoutable/u);
  assert.match(proxy, /localizedPath\.locale === DEFAULT_LOCALE/u);
  assert.equal((proxy.match(/updateSession\(/gu) ?? []).length, 1);
  assert.match(proxy, /const isAuthEntry =[\s\S]*pathname === '\/auth'/u);
  assert.match(proxy, /request\.nextUrl\.pathname !== url\.pathname/u);
  assert.match(proxy, /authRealmForSessionUser\(user\) !== authRealmForLocale\(locale\)/u);
  assert.match(switcher, /function setLocalePreference\(locale: AppLocale\)/u);
  assert.match(switcher, /LOCALE_COOKIE_NAME/u);
  assert.match(switcher, /localizePathname\(pathname, locale\)/u);
  assert.match(switcher, /window\.location\.search/u);
  assert.match(switcher, /SameSite=Lax/u);
  assert.match(switcher, /DropdownMenuRadioGroup/u);
  assert.match(switcher, /!hasSessionHint\(\)/u);
  // A locale change is an ordinary route change and must stay a soft App Router
  // navigation; only the signed-out realm transition may reload the document,
  // because the server has just replaced the auth cookies.
  assert.match(switcher, /openLocale\(navigationTarget\(pathname, nextLocale\)\)/u);
  assert.match(switcher, /const openLocale = \(target: string\) => \{[\s\S]*router\.replace\(target\)/u);
  assert.match(switcher, /window\.location\.assign\(payload\.redirectTo\)/u);
  assert.doesNotMatch(
    switcher,
    /window\.location\.assign\(navigationTarget\(pathname, nextLocale\)\)/u,
  );
  assert.ok(
    switcher.indexOf('if (!hasSessionHint())') < switcher.indexOf("fetch('/api/profile/locale'"),
    'guest locale navigation must precede and avoid the profile API request',
  );

  assert.doesNotMatch(requestConfig, /headers\(/u);
  assert.doesNotMatch(requestConfig, /LOCALE_HEADER_NAME/u);
  assert.match(privateLocale, /LOCALE_HEADER_NAME/u);
  assert.match(privateLocale, /getPrivateRequestLocale/u);
  assert.match(accountLayout, /loadMessages\(locale\)/u);
  assert.match(accountLayout, /locale=\{locale\}/u);
  assert.match(loginPage, /getPrivateRequestLocale\(\)/u);
  assert.match(loginPage, /locale === 'zh' \? <ZhUsernamePasswordFlow/u);
  assert.match(publicLayout, /export const revalidate = 300/u);
  assert.match(publicLayout, /setRequestLocale\(DEFAULT_LOCALE\)/u);
  assert.match(localizedLayout, /export const dynamicParams = false/u);
  assert.match(localizedLayout, /generateStaticParams/u);
  assert.match(localizedLayout, /setRequestLocale\(locale\)/u);
  assert.match(rootDocument, /translate="no"/u);
  assert.match(rootDocument, /className="notranslate"/u);
  assert.match(seo, /google:\s*'notranslate'/u);
  assert.match(rootDocument, /noto-sans-sc-ui\.f113fe63\.woff2/u);
});
