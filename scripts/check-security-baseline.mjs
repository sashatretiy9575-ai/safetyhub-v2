import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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

const secretPatterns = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bsb_secret_[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/gu,
];
const textualExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);
for (const file of files) {
  if (file !== '.env.example' && !textualExtensions.has(path.extname(file).toLowerCase())) continue;
  const source = readFileSync(path.join(repositoryRoot, file), 'utf8');
  if (secretPatterns.some((pattern) => pattern.test(source)))
    fail(`credential-like value in ${file}`);
  for (const pattern of secretPatterns) pattern.lastIndex = 0;
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
  const packageName = packagePath.replace(/^node_modules\//u, '');
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
