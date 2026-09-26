import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { scanForCredentials, TEXTUAL_EXTENSIONS } from './credential-scan.mjs';

const repositoryRoot = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function repositoryFiles() {
  // Include intended-but-not-yet-staged work. A pre-commit security check that
  // silently ignores new files can report green while the exact release diff
  // still contains a secret, unpinned workflow, or unsafe config artifact.
  const output = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  );
  return output
    .split('\0')
    .filter(Boolean)
    .filter((file) => existsSync(path.join(repositoryRoot, file)));
}

const files = repositoryFiles();
const forbiddenRepositoryPaths = files.filter((file) => {
  const normalized = file.replaceAll('\\', '/');
  const basename = path.posix.basename(normalized).toLowerCase();
  if (normalized === '.env.example') return false;
  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    normalized.startsWith('.vercel/') ||
    /\.(?:key|pem|p12|pfx)$/iu.test(basename)
  );
});
if (forbiddenRepositoryPaths.length > 0) {
  fail(`repository credential/config files: ${forbiddenRepositoryPaths.join(', ')}`);
}

for (const file of files) {
  if (file !== '.env.example' && !TEXTUAL_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
  const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
  for (const reason of scanForCredentials(source)) fail(`${reason} in ${file}`);
}

const workflowFiles = files.filter(
  (file) => file.startsWith('.github/workflows/') && /\.ya?ml$/iu.test(file),
);
const immutableAction = /^\s*[-]?\s*uses:\s*[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/iu;
for (const file of workflowFiles) {
  const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
  if (/\bpull_request_target\s*:/u.test(source)) fail(`${file} uses pull_request_target`);
  source.split(/\r?\n/u).forEach((line, index) => {
    if (/^\s*[-]?\s*uses:/u.test(line) && !immutableAction.test(line)) {
      fail(`${file}:${index + 1} action is not pinned to a full commit SHA`);
    }
  });
}

const lock = JSON.parse(readFileSync(path.join(repositoryRoot, 'package-lock.json'), 'utf8'));
if (lock.lockfileVersion !== 3) fail('package-lock.json must use lockfileVersion 3');
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!metadata.resolved) continue;
  if (!metadata.resolved.startsWith('https://registry.npmjs.org/')) {
    fail(`${packagePath || 'root'} resolves outside registry.npmjs.org`);
  }
  if (!metadata.integrity) fail(`${packagePath || 'root'} has no lockfile integrity hash`);
}

const packageManifest = JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const approvedInstallScripts = packageManifest.allowScripts ?? {};
for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!metadata.hasInstallScript) continue;
  // npm lockfiles can nest a second copy below
  // `node_modules/<parent>/node_modules/<package>`. `allowScripts` is keyed by
  // the actual package name/version, not by its installation location.
  const packageName = packagePath.split('node_modules/').at(-1) ?? packagePath;
  const approval = `${packageName}@${metadata.version}`;
  if (approvedInstallScripts[approval] !== true) {
    fail(`${approval} has install scripts but is not explicitly version-pinned in allowScripts`);
  }
}
const npmConfig = readFileSync(path.join(repositoryRoot, '.npmrc'), 'utf8');
if (!/^strict-allow-scripts=true$/mu.test(npmConfig)) {
  fail('.npmrc must enforce strict-allow-scripts=true');
}

if (failures.length > 0) {
  console.error('Security baseline check failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log(
  `Security baseline passed (${files.length} repository files, ${workflowFiles.length} workflow).`,
);
