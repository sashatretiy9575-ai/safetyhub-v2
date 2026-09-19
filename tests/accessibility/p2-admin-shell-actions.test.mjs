import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const h1Count = (source) => source.match(/<h1(?:\s|>)/g)?.length ?? 0;

test('avatar destinations preserve separate settings and audit permissions', async () => {
  const [menu, settings, audit, layout] = await Promise.all([
    read('components/shared/user-menu.tsx'),
    read('app/(admin)/admin/settings/page.tsx'),
    read('app/(admin)/admin/audit/page.tsx'),
    read('app/(admin)/admin/layout.tsx'),
  ]);
  assert.match(menu, /isAdmin && canManageSiteSettings/);
  assert.match(menu, /isAdmin && canReadAudit && !canManageSiteSettings/);
  assert.match(layout, /canReadAudit=\{actor\.capabilities\.includes\('audit.read'\)\}/);
  assert.match(settings, /requireCapability\('site.settings.manage'\)/);
  assert.match(audit, /requireCapability\('audit.read'\)/);
  assert.doesNotMatch(settings, /href="\/admin\/account"/);
  assert.match(menu, /href=\{ROUTES.adminAccount\}/);
});

test('admin shell exposes five operational sections and switches chrome at the laptop breakpoint', async () => {
  const [group, layout, navLink, rootLayout, publicShell, globals] = await Promise.all([
    read('app/(admin)/layout.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('components/admin/admin-nav-link.tsx'),
    read('app/(public)/layout.tsx'),
    read('components/layout/app-shell.tsx'),
    read('app/globals.css'),
  ]);
  for (const publicChrome of ['AppShell', 'Header', 'Footer', 'BottomTabBar']) {
    assert.doesNotMatch(group, new RegExp(publicChrome));
    assert.doesNotMatch(layout, new RegExp(`(?:import|<)${publicChrome}`));
  }
  for (const [href, label] of [
    ['/admin', 'В работе'],
    ['/admin/approvals', 'Заявки'],
    ['/admin/courses', 'Курсы'],
    ['/admin/articles', 'Материалы'],
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
  assert.match(layout, /<aside[\s\S]+lg:flex/);
  assert.match(layout, /<header[\s\S]+lg:hidden/);
  // The phone dock is the public site's floating pill, not a full-bleed bar. It
  // has no fixed height: below 360 px the five items wrap to two rows.
  assert.match(
    layout,
    /<nav\s+data-admin-mobile-nav[\s\S]+?className="glass-strong fixed [^"]*bottom-\[var\(--safe-area-bottom\)\][^"]*max-w-\[32\.5rem\] rounded-\[var\(--radius-dock\)\][^"]*lg:hidden"/,
  );
  assert.doesNotMatch(layout, /fixed inset-x-0 bottom-0/);
  const dockClasses = layout.match(/data-admin-mobile-nav[\s\S]+?className="([^"]+)"/)?.[1] ?? '';
  assert.doesNotMatch(dockClasses, /(?:^| )h-\[|(?:^| )w-full(?: |$)/);
  // Materials is a direct destination; settings belongs to the capability-gated avatar menu.
  assert.match(layout, /grid-cols-3/);
  assert.match(layout, /min-\[360px\]:grid-cols-5/);
  assert.doesNotMatch(layout, /xs:grid-cols-5|max-xs:pb-/);
  assert.match(
    layout,
    /pb-\[calc\(var\(--mobile-fixed-bottom-space\)\+5rem\)\][^"]*min-\[360px\]:pb-\[calc\(var\(--mobile-fixed-bottom-space\)\+1\.5rem\)\]/,
  );
  assert.match(layout, /<Icon size=\{21\} weight="regular" \/>/);
  assert.match(layout, /items\.map/);
  assert.doesNotMatch(layout, /AdminMoreMenu/);
  assert.match(
    layout,
    /canManageSiteSettings=\{actor\.capabilities\.includes\('site.settings.manage'\)\}/,
  );
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
  assert.match(
    publicShell,
    /pb-\[calc\(var\(--mobile-fixed-bottom-space\)\+var\(--pwa-banner-space,0px\)\)\]/,
  );
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
  const [validation, actionRoute, organizationRoute, manager, purge] = await Promise.all([
    read('lib/validation/admin.ts'),
    read('app/api/admin/attestations/actions/route.ts'),
    read('app/api/admin/organizations/merge/route.ts'),
    read('components/admin/attestations-manager.tsx'),
    read('app/api/admin/users/purge/route.ts'),
  ]);
  assert.match(
    validation,
    /adminActionReasonSchema = z\.string\(\)\.trim\(\)\.min\(10\)\.max\(500\)/,
  );
  assert.match(actionRoute, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(actionRoute, /max\(ADMIN_ATTESTATION_BULK_LIMIT\)/);
  assert.match(organizationRoute, /reason: z\.string\(\)\.trim\(\)\.min\(10\)\.max\(500\)/);
  assert.match(organizationRoute, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(purge, /purgeUsersSchema/);
  assert.match(validation, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(validation, /max\(ADMIN_PURGE_BULK_LIMIT\)/);
  assert.match(validation, /confirmation: z\.literal\('УДАЛИТЬ'\)/u);
  assert.match(manager, /УДАЛИТЬ \$\{actionSummary\.people\}/);
  assert.match(manager, /crypto\.randomUUID\(\)/);
});

test('role assignment is one bounded contract and the capability matrix stays absent', async () => {
  await assert.rejects(access(path.join(root, 'components/admin/user-manager.tsx')));
  await assert.rejects(access(path.join(root, 'components/admin/capability-manager.tsx')));
  await assert.rejects(access(path.join(root, 'app/api/admin/users/[userId]/role/route.ts')));
  await assert.rejects(
    access(path.join(root, 'app/api/admin/users/[userId]/capabilities/route.ts')),
  );
  const [roles, auth, operators, roleMigration] = await Promise.all([
    read('supabase/migrations/20260818000000_two_product_roles.sql'),
    read('server/auth/session.ts'),
    read('app/api/admin/operators/route.ts'),
    read('supabase/migrations/20260905110000_product_role_assignment_by_email.sql'),
  ]);
  assert.match(roles, /create type public\.product_role as enum \('participant', 'admin'\)/);
  assert.match(roles, /restore_admin_access/);
  assert.match(roles, /revoke execute on function public\.manage_user_role_confirmed/);
  assert.match(roles, /revoke execute on function public\.set_user_capabilities_confirmed/);
  assert.match(auth, /z\.enum\(\['participant', 'admin'\]\)/);

  // The single live path: appointment by verified email, with a written reason,
  // idempotent, capability-checked and quota-charged after authorization.
  assert.match(operators, /invalidOriginResponse\(request\)/);
  assert.match(operators, /operatorRoleByEmailSchema/);
  assert.match(operators, /requireCapability\('role\.manage'\)/);
  assert.match(operators, /consumeAdminMutationQuota\(\s*'admin\.access\.mutate'/);
  assert.doesNotMatch(operators, /user_capabilities|capabilities:|capabilityMatrix/u);
  assert.match(roleMigration, /create function public\.set_product_role_by_email/);
  assert.match(roleMigration, /private\.require_capability\('role\.manage'\)/);
  assert.match(roleMigration, /private\.lock_active_superadmin_invariant\(\)/);
  assert.match(roleMigration, /safetyhub\.skip_role_audit/);
  assert.match(roleMigration, /CANNOT_CHANGE_OWN_ROLE/);
  assert.match(roleMigration, /LAST_ACTIVE_ADMIN_PROTECTED/);
  assert.match(roleMigration, /SUPERADMIN_DEMOTION_FORBIDDEN/);
  assert.match(roleMigration, /'role\.changed'/);
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
