import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  ProductionAuthConfigPreparationError,
  configurationSha256,
  createProductionConfiguration,
  expectedProductionConfigurationSha256,
  expectedSourceConfigurationSha256,
  expectedTemplateSha256,
  localSupabaseCliPath,
  prepareProductionAuthConfig,
  productionSiteUrl,
  repositoryRoot,
  safeConfigPushCommand,
  templateSha256,
} from '../../scripts/prepare-production-auth-config.mjs';

async function listRelativeFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolutePath).split(path.sep).join('/'));
    }
  }
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

test('production Auth config preparation is isolated, exact, and does not push', async () => {
  const sourceConfigPath = path.join(repositoryRoot, 'supabase', 'config.toml');
  const sourceBefore = await readFile(sourceConfigPath, 'utf8');
  const prepared = await prepareProductionAuthConfig();

  try {
    assert.equal(path.isAbsolute(prepared.temporaryRoot), true);
    const relativeToRepository = path.relative(repositoryRoot, prepared.temporaryRoot);
    assert.equal(
      relativeToRepository === '..' ||
        relativeToRepository.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeToRepository),
      true,
    );
    assert.deepEqual(await listRelativeFiles(prepared.temporaryRoot), [
      'supabase/config.toml',
      'supabase/templates/confirmation.html',
      'supabase/templates/invite.html',
      'supabase/templates/magic-link.html',
      'supabase/templates/recovery.html',
    ]);
    assert.deepEqual(prepared.configurationDiff, [
      {
        source: 'site_url = "http://localhost:3000"',
        production: `site_url = "${productionSiteUrl}"`,
      },
      {
        source: 'additional_redirect_urls = ["http://localhost:3000/**"]',
        production: `additional_redirect_urls = ["${productionSiteUrl}/**"]`,
      },
    ]);

    const preparedConfig = await readFile(prepared.configurationPath, 'utf8');
    assert.equal(preparedConfig, createProductionConfiguration(sourceBefore));
    assert.equal(preparedConfig.includes('http://localhost:3000'), false);
    assert.equal(preparedConfig.includes(productionSiteUrl), true);
    assert.match(preparedConfig, /\[auth\.rate_limit\][\s\S]*?email_sent = 30/u);
    assert.equal(await readFile(sourceConfigPath, 'utf8'), sourceBefore);
    assert.equal(Object.keys(prepared.templateSha256).length, 4);
    assert.deepEqual(prepared.templateSha256, expectedTemplateSha256);
    for (const [relativePath, expectedHash] of Object.entries(expectedTemplateSha256)) {
      const actualTemplate = await readFile(path.join(prepared.temporaryRoot, relativePath));
      assert.equal(createHash('sha256').update(actualTemplate).digest('hex'), expectedHash);
    }
    assert.match(prepared.nextCommand, /^Push-Location /u);
    assert.match(prepared.nextCommand, /; try \{ & /u);
    assert.equal(prepared.nextCommand.includes(localSupabaseCliPath), true);
    assert.match(prepared.nextCommand, / config push --project-ref /u);
    assert.match(prepared.nextCommand, /\} finally \{ Pop-Location \}$/u);
    assert.doesNotMatch(prepared.nextCommand, /--workdir|\bnpx\b/u);
    assert.match(prepared.nextCommand, /REPLACE_WITH_TARGET_PROJECT_REF/u);
    assert.doesNotMatch(prepared.nextCommand, /(?:password|secret|token|key)=/iu);
  } finally {
    await rm(prepared.temporaryRoot, { recursive: true, force: true });
  }
});

test('production config hashes, email quota, and the two-line allowlist stay source-controlled', async () => {
  const sourceConfiguration = await readFile(
    path.join(repositoryRoot, 'supabase', 'config.toml'),
    'utf8',
  );
  const productionConfiguration = createProductionConfiguration(sourceConfiguration);
  assert.equal(configurationSha256(sourceConfiguration), expectedSourceConfigurationSha256);
  assert.equal(configurationSha256(productionConfiguration), expectedProductionConfigurationSha256);
  for (const configuration of [sourceConfiguration, productionConfiguration]) {
    assert.match(configuration, /\[auth\.rate_limit\][\s\S]*?email_sent = 30/u);
  }

  const crlfSource = sourceConfiguration.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  assert.equal(configurationSha256(crlfSource), expectedSourceConfigurationSha256);

  const recoveryTemplate = await readFile(
    path.join(repositoryRoot, 'supabase', 'templates', 'recovery.html'),
    'utf8',
  );
  const crlfTemplate = recoveryTemplate.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n');
  assert.equal(
    templateSha256(recoveryTemplate),
    expectedTemplateSha256['supabase/templates/recovery.html'],
  );
  assert.equal(
    templateSha256(crlfTemplate),
    expectedTemplateSha256['supabase/templates/recovery.html'],
  );
});

test('the tool refuses to create its temporary workdir inside the repository', async () => {
  await assert.rejects(
    () => prepareProductionAuthConfig({ temporaryDirectoryBase: repositoryRoot }),
    (error) =>
      error instanceof ProductionAuthConfigPreparationError &&
      error.code === 'TEMPORARY_DIRECTORY_INSIDE_REPOSITORY',
  );
});

test('the printed command has a harmless explicit project-ref placeholder', () => {
  const command = safeConfigPushCommand(path.resolve('C:/safe-temporary-workdir'));
  assert.match(command, /--project-ref 'REPLACE_WITH_TARGET_PROJECT_REF' \} finally/u);
  assert.equal(path.isAbsolute(localSupabaseCliPath), true);
  assert.equal(command.indexOf('Push-Location'), 0);
  assert.equal(command.indexOf(localSupabaseCliPath) > command.indexOf('try {'), true);
  assert.doesNotMatch(command, /SUPABASE_|NEXT_PUBLIC_|process\.env/u);
});
