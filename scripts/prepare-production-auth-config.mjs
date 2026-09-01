import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptFile = fileURLToPath(import.meta.url);

export const repositoryRoot = path.resolve(path.dirname(scriptFile), '..');
export const productionSiteUrl = 'https://safetyhub.kz';
export const temporaryDirectoryPrefix = 'safetyhub-production-auth-config-';
export const localSupabaseCliPath = path.join(
  repositoryRoot,
  'node_modules',
  'supabase',
  'dist',
  'supabase.js',
);

const configurationRelativePath = path.join('supabase', 'config.toml');
const templateRelativePaths = Object.freeze([
  path.join('supabase', 'templates', 'magic-link.html'),
  path.join('supabase', 'templates', 'confirmation.html'),
  path.join('supabase', 'templates', 'recovery.html'),
  path.join('supabase', 'templates', 'invite.html'),
]);

const expectedConfigurationLineChanges = Object.freeze([
  Object.freeze({
    source: 'site_url = "http://localhost:3000"',
    production: `site_url = "${productionSiteUrl}"`,
  }),
  Object.freeze({
    source: 'additional_redirect_urls = ["http://localhost:3000/**"]',
    production: `additional_redirect_urls = ["${productionSiteUrl}/**"]`,
  }),
]);

// Updating either value is an intentional release-review step. These hashes pin
// exactly the committed localhost source and the only permitted production copy.
export const expectedSourceConfigurationSha256 =
  '2e17fa5984321d1713caec61a7b0c54276b96e757d604adf0dee08a2168f4962';
export const expectedProductionConfigurationSha256 =
  '4a99a15e864ae823b715466e7025a59761b0c0769046370c22657ccbf62769d5';
export const expectedTemplateSha256 = Object.freeze({
  'supabase/templates/magic-link.html':
    'efcea98cd3cc116a6e4d1bd68d1a36d13618ab0583427df0994014b1d4598c89',
  'supabase/templates/confirmation.html':
    '2acfa9e9e97cd449e6dbc0f58475f5a7104c87f34ac45e3b9675ee7433844c36',
  'supabase/templates/recovery.html':
    'e9879969f6f2f1fecc5c3f20708d180733760523e08cbe4726b384603f841317',
  'supabase/templates/invite.html':
    '1d050c0cd78d364a57bf26a7a13f286018211cdd778593148672a2146f808f08',
});

export class ProductionAuthConfigPreparationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProductionAuthConfigPreparationError';
    this.code = code;
  }
}

function fail(code) {
  throw new ProductionAuthConfigPreparationError(code);
}

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function canonicalTemplateContents(contents) {
  if (typeof contents !== 'string') fail('TEMPLATE_SOURCE_INVALID');
  return contents.replaceAll('\r\n', '\n');
}

export function templateSha256(contents) {
  return sha256(Buffer.from(canonicalTemplateContents(contents), 'utf8'));
}

export function configurationSha256(configuration) {
  if (typeof configuration !== 'string') fail('CONFIGURATION_SOURCE_INVALID');
  return sha256(Buffer.from(configuration.replaceAll('\r\n', '\n'), 'utf8'));
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function toPortableRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

async function resolveRequiredFile(root, relativePath) {
  const candidate = path.resolve(root, relativePath);
  const resolved = await realpath(candidate).catch(() => fail('SOURCE_FILE_UNAVAILABLE'));
  if (!isInsideOrEqual(root, resolved)) fail('SOURCE_PATH_OUTSIDE_REPOSITORY');
  return resolved;
}

function lineChanges(source, production) {
  const sourceLines = source.split('\n').map((line) => line.replace(/\r$/u, ''));
  const productionLines = production.split('\n').map((line) => line.replace(/\r$/u, ''));
  if (sourceLines.length !== productionLines.length) fail('CONFIG_LINE_COUNT_CHANGED');

  return sourceLines.flatMap((sourceLine, index) => {
    const productionLine = productionLines[index];
    return sourceLine === productionLine
      ? []
      : [{ source: sourceLine, production: productionLine }];
  });
}

export function createProductionConfiguration(sourceConfiguration) {
  if (typeof sourceConfiguration !== 'string') fail('CONFIGURATION_SOURCE_INVALID');

  let productionConfiguration = sourceConfiguration;
  for (const change of expectedConfigurationLineChanges) {
    const occurrences = productionConfiguration.split(change.source).length - 1;
    if (occurrences !== 1) fail('CONFIGURATION_EXPECTED_LOCALHOST_VALUE_MISSING_OR_DUPLICATED');
    productionConfiguration = productionConfiguration.replace(change.source, change.production);
  }

  const actualChanges = lineChanges(sourceConfiguration, productionConfiguration);
  if (JSON.stringify(actualChanges) !== JSON.stringify(expectedConfigurationLineChanges)) {
    fail('CONFIGURATION_DIFF_OUTSIDE_ALLOWLIST');
  }
  if (productionConfiguration.includes('http://localhost:3000')) {
    fail('CONFIGURATION_LOCALHOST_ORIGIN_REMAINS');
  }
  return productionConfiguration;
}

async function listPreparedFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listPreparedFiles(root, absolutePath)));
      continue;
    }
    if (!entry.isFile()) fail('PREPARED_OUTPUT_CONTAINS_NON_FILE_ENTRY');
    files.push(toPortableRelativePath(path.relative(root, absolutePath)));
  }
  return files;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function safeConfigPushCommand(temporaryRoot) {
  if (!path.isAbsolute(temporaryRoot)) fail('TEMPORARY_DIRECTORY_MUST_BE_ABSOLUTE');
  return [
    `Push-Location ${quotePowerShell(temporaryRoot)};`,
    'try {',
    `& ${quotePowerShell(process.execPath)} ${quotePowerShell(localSupabaseCliPath)}`,
    "config push --project-ref 'REPLACE_WITH_TARGET_PROJECT_REF'",
    '} finally { Pop-Location }',
  ].join(' ');
}

export async function prepareProductionAuthConfig({
  sourceRepositoryRoot = repositoryRoot,
  temporaryDirectoryBase = os.tmpdir(),
} = {}) {
  const resolvedRepositoryRoot = await realpath(sourceRepositoryRoot).catch(() =>
    fail('REPOSITORY_ROOT_UNAVAILABLE'),
  );
  const resolvedTemporaryBase = await realpath(temporaryDirectoryBase).catch(() =>
    fail('TEMPORARY_DIRECTORY_BASE_UNAVAILABLE'),
  );
  if (isInsideOrEqual(resolvedRepositoryRoot, resolvedTemporaryBase)) {
    fail('TEMPORARY_DIRECTORY_INSIDE_REPOSITORY');
  }

  const configurationPath = await resolveRequiredFile(
    resolvedRepositoryRoot,
    configurationRelativePath,
  );
  const sourceConfiguration = await readFile(configurationPath, 'utf8').catch(() =>
    fail('CONFIGURATION_SOURCE_UNREADABLE'),
  );
  if (configurationSha256(sourceConfiguration) !== expectedSourceConfigurationSha256) {
    fail('CONFIGURATION_SOURCE_HASH_MISMATCH');
  }

  const templateContents = new Map();
  for (const relativePath of templateRelativePaths) {
    const templatePath = await resolveRequiredFile(resolvedRepositoryRoot, relativePath);
    const contents = await readFile(templatePath, 'utf8').catch(() =>
      fail('TEMPLATE_SOURCE_UNREADABLE'),
    );
    const portablePath = toPortableRelativePath(relativePath);
    if (templateSha256(contents) !== expectedTemplateSha256[portablePath])
      fail('TEMPLATE_SOURCE_HASH_MISMATCH');
    templateContents.set(relativePath, canonicalTemplateContents(contents));
  }

  const productionConfiguration = createProductionConfiguration(sourceConfiguration);
  if (configurationSha256(productionConfiguration) !== expectedProductionConfigurationSha256) {
    fail('CONFIGURATION_PRODUCTION_HASH_MISMATCH');
  }

  const temporaryRoot = await mkdtemp(path.join(resolvedTemporaryBase, temporaryDirectoryPrefix));
  let complete = false;
  try {
    const resolvedTemporaryRoot = await realpath(temporaryRoot).catch(() =>
      fail('TEMPORARY_DIRECTORY_UNAVAILABLE'),
    );
    if (isInsideOrEqual(resolvedRepositoryRoot, resolvedTemporaryRoot)) {
      fail('TEMPORARY_DIRECTORY_INSIDE_REPOSITORY');
    }

    const preparedSupabaseDirectory = path.join(resolvedTemporaryRoot, 'supabase');
    const preparedTemplatesDirectory = path.join(preparedSupabaseDirectory, 'templates');
    await mkdir(preparedSupabaseDirectory, { recursive: false });
    await mkdir(preparedTemplatesDirectory, { recursive: false });
    await chmod(preparedSupabaseDirectory, 0o700).catch(() => {});
    await chmod(preparedTemplatesDirectory, 0o700).catch(() => {});

    const preparedConfigurationPath = path.join(preparedSupabaseDirectory, 'config.toml');
    await writeFile(preparedConfigurationPath, productionConfiguration, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });

    for (const [relativePath, contents] of templateContents) {
      const destination = path.join(resolvedTemporaryRoot, relativePath);
      await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
    }

    const expectedPreparedFiles = [
      toPortableRelativePath(configurationRelativePath),
      ...templateRelativePaths.map(toPortableRelativePath),
    ].sort((left, right) => left.localeCompare(right, 'en'));
    const actualPreparedFiles = (await listPreparedFiles(resolvedTemporaryRoot)).sort(
      (left, right) => left.localeCompare(right, 'en'),
    );
    if (JSON.stringify(actualPreparedFiles) !== JSON.stringify(expectedPreparedFiles)) {
      fail('PREPARED_OUTPUT_FILESET_MISMATCH');
    }

    const preparedConfiguration = await readFile(preparedConfigurationPath, 'utf8');
    if (configurationSha256(preparedConfiguration) !== expectedProductionConfigurationSha256) {
      fail('PREPARED_CONFIGURATION_HASH_MISMATCH');
    }
    for (const relativePath of templateRelativePaths) {
      const preparedTemplate = await readFile(path.join(resolvedTemporaryRoot, relativePath));
      const portablePath = toPortableRelativePath(relativePath);
      if (sha256(preparedTemplate) !== expectedTemplateSha256[portablePath]) {
        fail('PREPARED_TEMPLATE_HASH_MISMATCH');
      }
    }

    complete = true;
    return {
      temporaryRoot: resolvedTemporaryRoot,
      configurationPath: preparedConfigurationPath,
      configurationDiff: lineChanges(sourceConfiguration, productionConfiguration),
      templateSha256: expectedTemplateSha256,
      nextCommand: safeConfigPushCommand(resolvedTemporaryRoot),
    };
  } finally {
    if (!complete) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function usage() {
  return 'Usage: node scripts/prepare-production-auth-config.mjs';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage());
    return;
  }
  if (args.length !== 0) fail('CLI_ARGUMENTS_UNSUPPORTED');

  const prepared = await prepareProductionAuthConfig();
  console.log('Prepared a verified production Auth config outside the repository.');
  console.log(`Temporary workdir: ${prepared.temporaryRoot}`);
  console.log('Only the approved Site URL and redirect URL differ from localhost config.');
  console.log('No cloud operation has been performed. After separate review, run:');
  console.log(prepared.nextCommand);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptFile;
if (isMain) {
  await main().catch((error) => {
    const code =
      error instanceof ProductionAuthConfigPreparationError ? error.code : 'UNEXPECTED_ERROR';
    console.error(`PRODUCTION_AUTH_CONFIG_PREPARATION_FAILED: ${code}`);
    process.exitCode = 1;
  });
}
