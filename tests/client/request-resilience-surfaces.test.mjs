import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('client mutations use bounded requests and release every busy scope in finally', async () => {
  const surfaces = [
    {
      file: 'components/admin/attestations-manager.tsx',
      releases: ['setBusy(false)'],
    },
    {
      file: 'components/admin/organization-cleanup-manager.tsx',
      releases: ['setBusy(false)'],
    },
    { file: 'components/admin/test-editor.tsx', releases: ['setBusy(false)'] },
    { file: 'components/admin/identity-controls.tsx', releases: ['setBusy(false)'] },
    { file: 'components/admin/certificate-revoke-control.tsx', releases: ['setBusy(false)'] },
    { file: 'features/auth/profile-form.tsx', releases: ['setBusy(false)'] },
  ];
  for (const { file, releases } of surfaces) {
    const source = await read(file);
    assert.match(source, /clientRequest|createClient/u, `${file} must use the shared request path`);
    assert.doesNotMatch(source, /await\s+fetch\s*\(/u, `${file} must not use unbounded fetch`);
    for (const release of releases) {
      const releaseAt = source.indexOf(release);
      const finallyAt = source.lastIndexOf('finally {', releaseAt);
      assert.ok(
        releaseAt >= 0 && finallyAt >= 0 && releaseAt - finallyAt < 250,
        `${file} must release ${release} in finally`,
      );
    }
  }
});

test('application ships no browser Supabase client or direct browser SDK imports', async () => {
  await assert.rejects(access(path.join(repositoryRoot, 'lib/supabase/client.ts')));
  const roots = ['app', 'components', 'features', 'lib'];
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(path.join(repositoryRoot, directory), {
      withFileTypes: true,
    })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(relative);
      else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(relative);
    }
  }
  for (const directory of roots) await walk(directory);
  for (const file of files) {
    const source = await read(file);
    assert.doesNotMatch(source, /createBrowserClient|@\/lib\/supabase\/client/,
      `${file} must use same-origin server boundaries`);
  }
});
