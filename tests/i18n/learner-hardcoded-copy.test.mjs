import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');

const SCAN_ROOTS = ['app', 'components', 'features'];
const CANONICAL_RU_CONTENT_SOURCES = new Set([
  // Published Russian legal revisions are immutable content, not UI copy. Other
  // locales are loaded fail-closed from legal_document_localizations.
  'app/(public)/privacy/page.tsx',
  'app/(public)/terms/page.tsx',
  'components/legal/privacy-policy-v1-2.tsx',
  'components/legal/terms-policy-v2-2.tsx',
]);

function isExcluded(relativePath) {
  return (
    relativePath.startsWith('app/(admin)/') ||
    relativePath.startsWith('app/api/') ||
    relativePath.startsWith('app/zip-harness/') ||
    relativePath.startsWith('components/admin/') ||
    relativePath.startsWith('features/admin/') ||
    CANONICAL_RU_CONTENT_SOURCES.has(relativePath)
  );
}

async function collectLearnerComponents(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectLearnerComponents(absolutePath, result);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.tsx')) continue;
    const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll(path.sep, '/');
    if (!isExcluded(relativePath)) result.push(relativePath);
  }
  return result;
}

test('learner-facing React components keep Cyrillic UI copy in locale catalogs', async () => {
  const files = (
    await Promise.all(
      SCAN_ROOTS.map((root) => collectLearnerComponents(path.join(repositoryRoot, root))),
    )
  ).flat();

  assert.ok(files.length > 0, 'learner component scan unexpectedly found no files');
  for (const relativePath of files) {
    const source = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    assert.doesNotMatch(source, /[\u0400-\u04ff]/u, relativePath);
  }
});
