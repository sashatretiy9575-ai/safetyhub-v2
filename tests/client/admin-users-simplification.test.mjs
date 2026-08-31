import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('the product has only participant/admin roles and no browser access editor', async () => {
  const [usersRedirect, accessRedirect, layout, auth, types, migration] = await Promise.all([
    read('app/(admin)/admin/users/page.tsx'),
    read('app/(admin)/admin/access/page.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('features/auth/server.ts'),
    read('lib/supabase/types.ts'),
    read('supabase/migrations/20260818000000_two_product_roles.sql'),
  ]);
  assert.match(usersRedirect, /redirect\('\/admin\/employees'\)/);
  assert.match(accessRedirect, /redirect\('\/admin\/settings'\)/);
  assert.doesNotMatch(layout, /\/admin\/(?:users|access)/);
  assert.match(auth, /z\.enum\(\['participant', 'admin'\]\)/);
  assert.match(types, /export type AppRole = 'participant' \| 'admin'/);
  assert.match(migration, /add column product_role public\.product_role/);
  assert.match(migration, /restore_admin_access/);
  await assert.rejects(access(path.join(repositoryRoot, 'components/admin/user-manager.tsx')));
  await assert.rejects(access(path.join(repositoryRoot, 'components/admin/capability-manager.tsx')));
});
