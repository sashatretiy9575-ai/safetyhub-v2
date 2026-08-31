import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIB = 1_024;

export const BUNDLE_BUDGETS = [
  {
    label: 'home',
    manifest: 'server/app/(public)/page_client-reference-manifest.js',
    buildManifest: 'server/app/(public)/page/build-manifest.json',
    pageEntry: '[project]/app/(public)/page',
    initial: 225 * KIB,
    route: 55 * KIB,
  },
  {
    label: 'admin employees',
    manifest: 'server/app/(admin)/admin/employees/page_client-reference-manifest.js',
    buildManifest: 'server/app/(admin)/admin/employees/page/build-manifest.json',
    pageEntry: '[project]/app/(admin)/admin/employees/page',
    initial: 280 * KIB,
    route: 110 * KIB,
  },
  {
    label: 'profile',
    manifest: 'server/app/(account)/profile/page_client-reference-manifest.js',
    buildManifest: 'server/app/(account)/profile/page/build-manifest.json',
    pageEntry: '[project]/app/(account)/profile/page',
    initial: 310 * KIB,
    route: 140 * KIB,
  },
  {
    label: 'onboarding',
    manifest: 'server/app/(account)/onboarding/page_client-reference-manifest.js',
    buildManifest: 'server/app/(account)/onboarding/page/build-manifest.json',
    pageEntry: '[project]/app/(account)/onboarding/page',
    initial: 310 * KIB,
    route: 140 * KIB,
  },
  {
    label: 'course detail',
    manifest: 'server/app/(public)/topics/[slug]/page_client-reference-manifest.js',
    buildManifest: 'server/app/(public)/topics/[slug]/page/build-manifest.json',
    pageEntry: '[project]/app/(public)/topics/[slug]/page',
    initial: 225 * KIB,
    route: 20 * KIB,
  },
];

export const CSS_BUDGET = 20 * KIB;

export function parseClientReferenceManifest(source, label = 'route') {
  const assignment = source.lastIndexOf('globalThis.__RSC_MANIFEST[');
  const valueStart = source.indexOf(' = ', assignment) + 3;
  const valueEnd = source.lastIndexOf(';');
  if (assignment < 0 || valueStart < 3 || valueEnd <= valueStart) {
    throw new Error(`${label}: unsupported Next client-reference manifest format`);
  }
  try {
    return JSON.parse(source.slice(valueStart, valueEnd));
  } catch (error) {
    throw new Error(`${label}: invalid Next client-reference manifest JSON`, { cause: error });
  }
}

export function resolveRouteAssets(clientManifest, buildManifest, pageEntry, label = 'route') {
  const entries = clientManifest.entryJSFiles;
  const rootMainFiles = buildManifest.rootMainFiles;
  if (!entries || typeof entries !== 'object' || !Array.isArray(rootMainFiles)) {
    throw new Error(`${label}: incomplete Next build manifests`);
  }
  const pageFiles = entries[pageEntry];
  if (!Array.isArray(pageFiles)) {
    throw new Error(`${label}: page entry ${pageEntry} is missing from the client manifest`);
  }

  const inherited = new Set(rootMainFiles);
  for (const [entry, files] of Object.entries(entries)) {
    if (!Array.isArray(files)) throw new Error(`${label}: malformed JS entry ${entry}`);
    if (entry !== pageEntry) for (const file of files) inherited.add(file);
  }

  const initial = new Set(rootMainFiles);
  for (const files of Object.values(entries)) for (const file of files) initial.add(file);
  const route = new Set(pageFiles.filter((file) => !inherited.has(file)));
  const css = new Set();
  for (const files of Object.values(clientManifest.entryCSSFiles ?? {})) {
    if (!Array.isArray(files)) throw new Error(`${label}: malformed CSS entry`);
    for (const file of files) {
      const asset = typeof file === 'string' ? file : file?.path;
      if (typeof asset !== 'string') throw new Error(`${label}: malformed CSS asset`);
      css.add(asset);
    }
  }
  return { initial, route, css };
}

async function gzipAssets(buildDirectory, assets) {
  const resolvedBuildDirectory = path.resolve(buildDirectory);
  let bytes = 0;
  for (const asset of assets) {
    const resolvedAsset = path.resolve(resolvedBuildDirectory, asset);
    if (!resolvedAsset.startsWith(`${resolvedBuildDirectory}${path.sep}`)) {
      throw new Error(`Unsafe bundle asset path: ${asset}`);
    }
    const contents = await readFile(resolvedAsset);
    bytes += gzipSync(contents, { level: 9 }).byteLength;
  }
  return bytes;
}

export function budgetViolations(result, budget, cssBudget = CSS_BUDGET) {
  const violations = [];
  if (result.initial > budget.initial) violations.push('initial JS');
  if (result.route > budget.route) violations.push('route JS');
  if (result.css > cssBudget) violations.push('CSS');
  return violations;
}

function kib(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

export async function checkBundleBudgets({
  buildDirectory = path.resolve('.next'),
  budgets = BUNDLE_BUDGETS,
} = {}) {
  const results = [];
  for (const budget of budgets) {
    const [manifestSource, buildManifestSource] = await Promise.all([
      readFile(path.join(buildDirectory, budget.manifest), 'utf8'),
      readFile(path.join(buildDirectory, budget.buildManifest), 'utf8'),
    ]).catch((error) => {
      throw new Error(
        `${budget.label}: production manifests are missing; run npm run build first`,
        {
          cause: error,
        },
      );
    });
    const clientManifest = parseClientReferenceManifest(manifestSource, budget.label);
    const buildManifest = JSON.parse(buildManifestSource);
    const assets = resolveRouteAssets(
      clientManifest,
      buildManifest,
      budget.pageEntry,
      budget.label,
    );
    const [initial, route, css] = await Promise.all([
      gzipAssets(buildDirectory, assets.initial),
      gzipAssets(buildDirectory, assets.route),
      gzipAssets(buildDirectory, assets.css),
    ]);
    results.push({ ...budget, initialBytes: initial, routeBytes: route, cssBytes: css });
  }

  let failed = false;
  for (const result of results) {
    const measured = {
      initial: result.initialBytes,
      route: result.routeBytes,
      css: result.cssBytes,
    };
    const violations = budgetViolations(measured, result);
    failed ||= violations.length > 0;
    console.log(
      `${violations.length ? 'FAIL' : 'PASS'} ${result.label}: ` +
        `initial ${kib(measured.initial)}/${kib(result.initial)}, ` +
        `route ${kib(measured.route)}/${kib(result.route)}, ` +
        `CSS ${kib(measured.css)}/${kib(CSS_BUDGET)}`,
    );
  }
  if (failed) throw new Error('Production bundle budget exceeded');
  return results;
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (invokedAsScript) {
  checkBundleBudgets().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
