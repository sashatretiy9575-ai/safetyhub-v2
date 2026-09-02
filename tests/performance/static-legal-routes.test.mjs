import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (pathname) => readFile(new URL(`../../${pathname}`, import.meta.url), 'utf8');

test('public legal documents use immutable local data and static physical routes', async () => {
  const [
    loader,
    proxy,
    privacy,
    terms,
    localizedPrivacy,
    localizedTerms,
    privacyVersion,
    termsVersion,
    localizedPrivacyVersion,
    localizedTermsVersion,
  ] = await Promise.all([
    read('lib/content/legal-documents.ts'),
    read('proxy.ts'),
    read('app/(public)/privacy/page.tsx'),
    read('app/(public)/terms/page.tsx'),
    read('app/[locale]/(public)/privacy/page.tsx'),
    read('app/[locale]/(public)/terms/page.tsx'),
    read('app/(public)/privacy/[version]/page.tsx'),
    read('app/(public)/terms/[version]/page.tsx'),
    read('app/[locale]/(public)/privacy/[version]/page.tsx'),
    read('app/[locale]/(public)/terms/[version]/page.tsx'),
  ]);

  assert.match(loader, /path\.join\(process\.cwd\(\), 'content', 'legal'\)/u);
  assert.match(loader, /'content',[\s\S]*?'snapshots',[\s\S]*?'localizations',[\s\S]*?'manifest\.json'/u);
  assert.match(loader, /export function getStaticLegalDocument/);
  assert.match(loader, /export function staticLegalVersions/);
  assert.match(loader, /hasLegacyRussianLegalRenderer/);
  assert.doesNotMatch(loader, /createClient|createAdminClient|@\/lib\/supabase\/server|cookies\(/u);

  for (const page of [privacy, terms, localizedPrivacy, localizedTerms]) {
    assert.match(page, /getStaticLegalDocument/);
    assert.match(page, /export const revalidate = 300/);
    assert.doesNotMatch(page, /searchParams|resolveActivatedLegalPolicy|getLocalizedLegalDocument|getLocale\(/u);
  }

  for (const page of [privacyVersion, termsVersion, localizedPrivacyVersion, localizedTermsVersion]) {
    assert.match(page, /generateStaticParams/);
    assert.match(page, /export const dynamicParams = false/);
    assert.match(page, /export const revalidate = 300/);
    assert.match(page, /StaticLegalDocument/);
  }

  assert.match(proxy, /\^\\\/privacy\\\/\[\^\/\]\+\$\/u\.test\(pathname\)/u);
  assert.match(proxy, /\^\\\/terms\\\/\[\^\/\]\+\$\/u\.test\(pathname\)/u);
  assert.match(proxy, /legacyLegalType/);
  assert.match(proxy, /request\.nextUrl\.searchParams\.has\('version'\)/u);
  assert.match(proxy, /destination\.searchParams\.delete\('version'\)/u);
  assert.match(proxy, /private, no-store/);
  assert.match(proxy, /s-maxage=300, stale-while-revalidate=86400/);
});
