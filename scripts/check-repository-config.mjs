import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { parse } from 'yaml';

const failures = [];

function assert(condition, message) {
  if (!condition) failures.push(message);
}

async function readYaml(path) {
  try {
    return parse(await readFile(path, 'utf8'));
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : 'invalid YAML'}`);
    return null;
  }
}

const dependabot = await readYaml('.github/dependabot.yml');
assert(dependabot?.version === 2, 'Dependabot config must use version 2.');
assert(Array.isArray(dependabot?.updates), 'Dependabot config must contain an updates array.');
for (const [index, update] of (dependabot?.updates ?? []).entries()) {
  assert(
    typeof update?.['package-ecosystem'] === 'string',
    `Dependabot update ${index + 1} is missing package-ecosystem.`,
  );
  assert(
    update?.directory === '/',
    `Dependabot update ${index + 1} must target the repository root.`,
  );
  assert(
    typeof update?.schedule?.interval === 'string',
    `Dependabot update ${index + 1} is missing its nested schedule.`,
  );
}

const workflow = await readYaml('.github/workflows/ci.yml');
const workflowSource = await readFile('.github/workflows/ci.yml', 'utf8');
const verifySteps = workflow?.jobs?.verify?.steps ?? [];
const runCommands = verifySteps
  .map((step) => step?.run)
  .filter(Boolean)
  .join('\n');
assert(runCommands.includes('npm run seed:workspace'), 'CI must seed authenticated workspaces.');
assert(runCommands.includes('supabase db reset'), 'CI must rebuild Supabase from every migration.');
assert(runCommands.includes('npm run test:db'), 'CI must run SQL contract tests.');
assert(runCommands.includes('npm run check:db-types'), 'CI must check Supabase type contracts.');
assert(runCommands.includes('npm run test:e2e:release'), 'CI must run strict authenticated E2E.');
assert(
  workflow?.jobs?.verify?.env?.E2E_REQUIRE_AUTH === '1',
  'CI must require authenticated E2E credentials.',
);
assert(
  !/SAFETYHUB_SEED_PASSWORD|E2E_(?:CI_)?PASSWORD/u.test(workflowSource),
  'CI must not restore a password credential path for authenticated E2E.',
);

if (failures.length) {
  for (const failure of failures) console.error(`CONFIG_INVALID: ${failure}`);
  process.exit(1);
}

console.log('Repository YAML and release configuration are valid.');
