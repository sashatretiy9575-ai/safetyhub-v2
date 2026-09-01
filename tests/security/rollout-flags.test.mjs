import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { ROLLOUT_FEATURE_ENV, rolloutFeatureEnabled } from '../../lib/release/rollout-flags.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('new production surfaces are fail-closed and require exact opt-in', () => {
  for (const feature of Object.keys(ROLLOUT_FEATURE_ENV)) {
    assert.equal(rolloutFeatureEnabled(feature, { NODE_ENV: 'development' }), true);
    assert.equal(rolloutFeatureEnabled(feature, { NODE_ENV: 'test' }), true);
    assert.equal(rolloutFeatureEnabled(feature, { NODE_ENV: 'production' }), false);
    assert.equal(rolloutFeatureEnabled(feature, { VERCEL_ENV: 'preview' }), false);
    assert.equal(rolloutFeatureEnabled(feature, { VERCEL_ENV: 'production' }), false);
    assert.equal(
      rolloutFeatureEnabled(feature, {
        NODE_ENV: 'production',
        [ROLLOUT_FEATURE_ENV[feature]]: 'true',
      }),
      true,
    );
    assert.equal(
      rolloutFeatureEnabled(feature, {
        NODE_ENV: 'development',
        [ROLLOUT_FEATURE_ENV[feature]]: 'unexpected',
      }),
      true,
    );
    assert.equal(
      rolloutFeatureEnabled(feature, {
        NODE_ENV: 'production',
        [ROLLOUT_FEATURE_ENV[feature]]: 'unexpected',
      }),
      false,
    );
  }
});

test('locale, ZH auth, and admin inbox entry points are wired to independent gates', async () => {
  const [
    proxy,
    login,
    register,
    zhServer,
    adminLayout,
    inboxRoute,
    inboxReadRoute,
    inboxRetryRoute,
    sitemap,
    manifest,
    offline,
    seo,
  ] = await Promise.all([
    read('proxy.ts'),
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
    read('features/auth/zh-webauthn-server.ts'),
    read('app/(admin)/admin/layout.tsx'),
    read('app/api/admin/notifications/route.ts'),
    read('app/api/admin/notifications/read/route.ts'),
    read('app/api/admin/notifications/[eventId]/retry/route.ts'),
    read('app/sitemap.ts'),
    read('app/manifest/[locale]/route.ts'),
    read('app/offline/[locale]/route.ts'),
    read('lib/seo.ts'),
  ]);

  for (const source of [proxy, sitemap, manifest, offline, seo]) {
    assert.match(source, /rolloutFeatureEnabled\('localeRoutes'\)/u);
  }
  for (const source of [login, register, zhServer]) {
    assert.match(source, /rolloutFeatureEnabled\('zhPasskey'\)/u);
  }
  for (const source of [adminLayout, inboxRoute, inboxReadRoute, inboxRetryRoute]) {
    assert.match(source, /rolloutFeatureEnabled\('adminInbox'\)/u);
  }
  assert.match(proxy, /!localeRoutesEnabled && localizedPath\.hasLocalePrefix/u);
  assert.match(zhServer, /function requireZhPasskeyRollout\(\)/u);
  assert.equal((zhServer.match(/requireZhPasskeyRollout\(\);/gu) ?? []).length, 6);
});
