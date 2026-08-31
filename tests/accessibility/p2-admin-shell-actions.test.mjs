import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const h1Count = (source) => source.match(/<h1(?:\s|>)/g)?.length ?? 0;

test('admin shell exposes five product sections and switches chrome at the laptop breakpoint', async () => {
  const [group, layout, navLink, rootLayout, publicShell, globals] = await Promise.all([
    read('app/(admin)/layout.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('components/admin/admin-nav-link.tsx'),
    read('app/layout.tsx'),
    read('components/layout/app-shell.tsx'),
    read('app/globals.css'),
  ]);
  for (const publicChrome of ['AppShell', 'Header', 'Footer', 'BottomTabBar']) {
    assert.doesNotMatch(group, new RegExp(publicChrome));
    assert.doesNotMatch(layout, new RegExp(`(?:import|<)${publicChrome}`));
  }
  for (const [href, label] of [
    ['/admin', 'В работе'],
    ['/admin/courses', 'Курсы'],
    ['/admin/articles', 'Материалы'],
    ['/admin/settings', 'Настройки'],
  ]) {
    assert.match(layout, new RegExp(`href: '${href.replaceAll('/', '\\/')}'.+label: '${label}'`));
  }
  assert.match(
    layout,
    /actor\.capabilities\.includes\('results\.read'\)[\s\S]*'\/admin\/employees'/,
  );
  assert.match(
    layout,
    /actor\.capabilities\.includes\('results\.delete'\)[\s\S]*'\/admin\/employees\/directory'/,
  );
  assert.match(layout, /href: employeeHref, icon: Users, label: 'Сотрудники'/);
  assert.doesNotMatch(layout, /href: '\/admin\/(?:users|access|audit|attestations|results)'/);
  assert.match(layout, /data-admin-shell/);
  assert.match(layout, /<aside[\s\S]+min-\[1180px\]:flex/);
  assert.match(layout, /<header[\s\S]+min-\[1180px\]:hidden/);
  assert.match(layout, /<nav[\s\S]+fixed inset-x-0 bottom-0[\s\S]+min-\[1180px\]:hidden/);
  assert.match(layout, /grid[^"\n]*grid-cols-5/);
  assert.doesNotMatch(layout, /overflow-x-auto/);
  assert.match(layout, /size="admin"/);
  assert.match(layout, /admin-workspace-container/);
  assert.match(globals, /container-type: inline-size/);
  assert.match(globals, /container-name: admin-workspace/);
  assert.match(layout, /var\(--safe-area-(?:top|bottom|left|right)\)/);
  assert.equal(layout.match(/<main(?:\s|>)/g)?.length, 1);
  assert.equal(h1Count(layout), 0);
  assert.match(navLink, /aria-current=\{active \? 'page' : undefined\}/);
  assert.doesNotMatch(rootLayout, /mobile-fixed-bottom-space/);
  assert.match(publicShell, /pb-\[var\(--mobile-fixed-bottom-space\)\]/);
});

test('canonical admin screens own one heading while retained compatibility screens only redirect', async () => {
  for (const file of [
    'app/(admin)/admin/page.tsx',
    'app/(admin)/admin/employees/page.tsx',
    'app/(admin)/admin/audit/page.tsx',
    'app/(admin)/admin/courses/page.tsx',
    'app/(admin)/admin/courses/new/page.tsx',
    'app/(admin)/admin/courses/[id]/page.tsx',
    'app/(admin)/admin/articles/page.tsx',
    'app/(admin)/admin/settings/page.tsx',
    'app/(admin)/admin/organizations/cleanup/page.tsx',
    'app/(admin)/admin/error.tsx',
  ]) {
    assert.equal(h1Count(await read(file)), 1, `${file} must render exactly one h1`);
  }
  for (const file of [
    'app/(admin)/admin/users/page.tsx',
    'app/(admin)/admin/access/page.tsx',
    'app/(admin)/admin/attestations/page.tsx',
    'app/(admin)/admin/results/page.tsx',
  ]) {
    assert.match(await read(file), /redirect\((?:'|`)/, `${file} must be a compatibility redirect`);
  }
  assert.equal(h1Count(await read('components/admin/admin-editor.tsx')), 1);
});

test('dangerous operator payloads are bounded, reasoned and idempotent', async () => {
  const [validation, actionRoute, organizationRoute, manager] = await Promise.all([
    read('lib/validation/admin.ts'),
    read('app/api/admin/attestations/actions/route.ts'),
    read('app/api/admin/organizations/merge/route.ts'),
    read('components/admin/attestations-manager.tsx'),
  ]);
  assert.match(
    validation,
    /adminActionReasonSchema = z\.string\(\)\.trim\(\)\.min\(10\)\.max\(500\)/,
  );
  assert.match(actionRoute, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(actionRoute, /max\(ADMIN_ATTESTATION_BULK_LIMIT\)/);
  assert.match(organizationRoute, /reason: z\.string\(\)\.trim\(\)\.min\(10\)\.max\(500\)/);
  assert.match(organizationRoute, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(manager, /ОТОЗВАТЬ \$\{selectionSummary\.issued\}/);
  assert.match(manager, /crypto\.randomUUID\(\)/);
});

test('confirmation dialog has browser-native modal and accessible cancel semantics', async () => {
  const dialog = await read('components/admin/admin-action-dialog.tsx');
  assert.match(dialog, /<dialog/);
  assert.match(dialog, /\.showModal\(\)/);
  assert.match(dialog, /aria-labelledby=\{titleId\}/);
  assert.match(dialog, /aria-describedby=\{descriptionId\}/);
  assert.match(dialog, /aria-busy=\{busy \|\| undefined\}/);
  assert.match(dialog, /onCancel=\{\(event\) =>/);
  assert.match(dialog, /type="button"[\s\S]+onClick=\{cancel\}/);
  assert.match(dialog, /minLength=\{10\}/);
  assert.match(dialog, /maxLength=\{500\}/);
});

test('role and capability editing are absent from the product surface', async () => {
  await assert.rejects(access(path.join(root, 'components/admin/user-manager.tsx')));
  await assert.rejects(access(path.join(root, 'components/admin/capability-manager.tsx')));
  await assert.rejects(access(path.join(root, 'app/api/admin/users/[userId]/role/route.ts')));
  await assert.rejects(
    access(path.join(root, 'app/api/admin/users/[userId]/capabilities/route.ts')),
  );
  const [roles, auth] = await Promise.all([
    read('supabase/migrations/20260818000000_two_product_roles.sql'),
    read('features/auth/server.ts'),
  ]);
  assert.match(roles, /create type public\.product_role as enum \('participant', 'admin'\)/);
  assert.match(roles, /restore_admin_access/);
  assert.match(roles, /revoke execute on function public\.manage_user_role_confirmed/);
  assert.match(roles, /revoke execute on function public\.set_user_capabilities_confirmed/);
  assert.match(auth, /z\.enum\(\['participant', 'admin'\]\)/);
});

test('database operations recheck capability and audit a batch atomically', async () => {
  const migration = await read(
    'supabase/migrations/20260818030000_idempotent_attestation_actions.sql',
  );
  assert.match(migration, /create function public\.execute_admin_attestation_action/);
  assert.match(migration, /private\.require_capability/);
  assert.match(migration, /for update/iu);
  assert.match(migration, /idempotency_key/);
  assert.match(migration, /operation_receipts/);
  assert.match(migration, /admin_audit_log/);
  assert.match(migration, /batch_id/);
});
