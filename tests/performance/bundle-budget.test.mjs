import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  BUNDLE_BUDGETS,
  CSS_BUDGET,
  budgetViolations,
  parseClientReferenceManifest,
  resolveRouteAssets,
} from '../../scripts/check-bundle-budgets.mjs';

test('bundle accounting deduplicates shared chunks and isolates the leaf route entry', () => {
  const payload = {
    entryJSFiles: {
      '[project]/app/layout': ['root.js', 'layout.js'],
      '[project]/app/(public)/layout': ['layout.js', 'public.js'],
      '[project]/app/(public)/page': ['public.js', 'home.js'],
    },
    entryCSSFiles: {
      '[project]/app/layout': [{ path: 'global.css' }],
      '[project]/app/(public)/page': [{ path: 'global.css' }, { path: 'home.css' }],
    },
  };
  const source =
    `globalThis.__RSC_MANIFEST = globalThis.__RSC_MANIFEST || {};\n` +
    `globalThis.__RSC_MANIFEST["/(public)/page"] = ${JSON.stringify(payload)};\n`;
  const manifest = parseClientReferenceManifest(source, 'fixture');
  const assets = resolveRouteAssets(
    manifest,
    { rootMainFiles: ['runtime.js', 'root.js'] },
    '[project]/app/(public)/page',
    'fixture',
  );

  assert.deepEqual([...assets.initial].sort(), [
    'home.js',
    'layout.js',
    'public.js',
    'root.js',
    'runtime.js',
  ]);
  assert.deepEqual([...assets.route], ['home.js']);
  assert.deepEqual([...assets.css].sort(), ['global.css', 'home.css']);
});

test('approved production budgets fail closed at the first byte over a limit', () => {
  assert.deepEqual(
    BUNDLE_BUDGETS.map(({ label }) => label),
    ['home', 'admin employees', 'profile', 'onboarding', 'course detail'],
  );
  assert.equal(CSS_BUDGET, 20 * 1_024);
  for (const budget of BUNDLE_BUDGETS) {
    assert.deepEqual(
      budgetViolations({ initial: budget.initial, route: budget.route, css: CSS_BUDGET }, budget),
      [],
    );
    assert.deepEqual(
      budgetViolations(
        { initial: budget.initial + 1, route: budget.route + 1, css: CSS_BUDGET + 1 },
        budget,
      ),
      ['initial JS', 'route JS', 'CSS'],
    );
  }
});

test('package verification and CI run contact and bundle guards in the required order', async () => {
  const [packageSource, workflow] = await Promise.all([
    readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  ]);
  const scripts = JSON.parse(packageSource).scripts;
  assert.equal(scripts['check:bundles'], 'node scripts/check-bundle-budgets.mjs');
  assert.ok(scripts.verify.indexOf('npm run check:contacts') >= 0);
  assert.ok(
    scripts.verify.indexOf('npm run build') < scripts.verify.indexOf('npm run check:bundles'),
  );
  assert.match(workflow, /- run: npm run check:contacts/);
  assert.ok(
    workflow.indexOf('- run: npm run build') < workflow.indexOf('- run: npm run check:bundles'),
  );
});
