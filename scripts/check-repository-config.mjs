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
const applicationSteps = workflow?.jobs?.application?.steps ?? [];
const databaseSteps = workflow?.jobs?.database?.steps ?? [];
const applicationCommands = applicationSteps
  .map((step) => step?.run)
  .filter(Boolean)
  .join('\n');
const databaseCommands = databaseSteps
  .map((step) => step?.run)
  .filter(Boolean)
  .join('\n');
assert(applicationCommands.includes('npm run verify') === false, 'CI application checks must stay inspectable.');
assert(applicationCommands.includes('npm run lint'), 'CI application job must run lint.');
assert(applicationCommands.includes('npm run type-check'), 'CI application job must run TypeScript.');
assert(applicationCommands.includes('npm test'), 'CI application job must run Node tests.');
assert(applicationCommands.includes('npm run build'), 'CI application job must build the application.');
assert(
  databaseCommands.includes('npm run seed:workspace'),
  'CI database job must seed authenticated workspaces.',
);
assert(
  databaseCommands.includes('supabase db reset'),
  'CI database job must rebuild Supabase from every migration.',
);
assert(databaseCommands.includes('npm run test:db'), 'CI database job must run SQL contract tests.');
assert(
  databaseCommands.includes('npm run db:types:check:local'),
  'CI must reject stale exact generated database types from the clean local schema.',
);
assert(databaseCommands.includes('npm run check:db-types'), 'CI must check Supabase type contracts.');
assert(databaseCommands.includes('npm run test:e2e:release'), 'CI must run strict authenticated E2E.');
assert(
  workflow?.jobs?.database?.env?.E2E_REQUIRE_AUTH === '1',
  'CI must require authenticated E2E credentials.',
);
for (const [jobName, steps] of [
  ['application', applicationSteps],
  ['database', databaseSteps],
]) {
  assert(
    String(steps.find((step) => step?.uses?.startsWith('actions/setup-node@'))?.with?.[
      'node-version'
    ]) === '24',
    `CI ${jobName} job must run the supported Node.js 24 toolchain.`,
  );
}
assert(workflow?.permissions?.contents === 'read', 'CI must use read-only repository permissions.');
assert(
  workflowSource.includes('::add-mask::$SERVICE_ROLE_KEY'),
  'CI must mask the disposable local service-role key before later steps can log it.',
);
const generatedTypesArtifact = databaseSteps.find(
  (step) => step?.name === 'Upload verified database types',
);
assert(
  generatedTypesArtifact && !generatedTypesArtifact.if,
  'CI must upload database types only after the exact local type check succeeds.',
);
assert(
  !/SAFETYHUB_SEED_PASSWORD|E2E_(?:CI_)?PASSWORD/u.test(workflowSource),
  'CI must not restore a password credential path for authenticated E2E.',
);

const receiptWorkflow = await readYaml('.github/workflows/schema-receipt.yml');
const receiptWorkflowSource = await readFile('.github/workflows/schema-receipt.yml', 'utf8');
const receiptTriggers = Object.keys(receiptWorkflow?.on ?? {});
const receiptSteps = receiptWorkflow?.jobs?.['schema-receipt']?.steps ?? [];
const receiptCommands = receiptSteps
  .map((step) => step?.run)
  .filter(Boolean)
  .join('\n');
assert(
  receiptTriggers.length === 1 && receiptTriggers[0] === 'workflow_dispatch',
  'Schema receipt workflow must be manual-only.',
);
assert(
  receiptWorkflow?.permissions?.contents === 'read',
  'Schema receipt workflow must use read-only repository permissions.',
);
assert(
  receiptCommands.includes('supabase db reset'),
  'Schema receipt must rebuild disposable Supabase from every migration.',
);
assert(
  receiptCommands.includes('npm run db:types:generate:local'),
  'Schema receipt must generate exact CLI database types.',
);
assert(
  receiptCommands.includes('npm run db:types:check:local') &&
    receiptCommands.includes('npm run check:db-types') &&
    receiptCommands.includes('npm run test:db'),
  'Schema receipt must verify generated types and SQL contracts.',
);
assert(receiptWorkflowSource.includes('sha256sum'), 'Schema receipt must include a SHA-256 checksum.');
const receiptArtifact = receiptSteps.find((step) => step?.name === 'Upload verified schema receipt');
assert(
  receiptArtifact && !receiptArtifact.if,
  'Schema receipt artifact must upload only after all database checks pass.',
);
assert(
  !/SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SECRET_KEY)|NEXT_PUBLIC_SUPABASE_/u.test(
    receiptWorkflowSource,
  ),
  'Schema receipt must not depend on linked or production Supabase credentials.',
);

if (failures.length) {
  for (const failure of failures) console.error(`CONFIG_INVALID: ${failure}`);
  process.exit(1);
}

console.log('Repository YAML and release configuration are valid.');
