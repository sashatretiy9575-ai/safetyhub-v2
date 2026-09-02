import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('unified attestation read model is bounded, filterable, sorted, and cursor paginated', async () => {
  const server = await read('features/admin/attestations.ts');
  assert.match(server, /ADMIN_ATTESTATION_DEFAULT_PAGE_SIZE = 50/);
  assert.match(server, /ADMIN_ATTESTATION_PAGE_SIZES = \[25, 50, 100\]/);
  for (const filter of [
    'p_query',
    'p_organization',
    'p_test_id',
    'p_result_state',
    'p_certificate_state',
    'p_from',
    'p_to',
    'p_sort',
    'p_cursor',
  ]) {
    assert.match(server, new RegExp(filter));
  }
  assert.match(server, /list_admin_attestations_page/);
  assert.match(server, /score_desc/);
  assert.match(server, /organization_asc/);
  assert.match(server, /Buffer\.from\(JSON\.stringify\(cursor\)/);
  assert.match(server, /get_admin_attestation_filters/);
  assert.match(server, /uniquePeople: first\(selection, 'uniquePeople', 'unique_people'\)/);
  assert.match(
    server,
    /pendingIdentity: first\(selection, 'pendingIdentity', 'pending_identity'\)/,
  );
  assert.match(server, /exportable: first\(selection, 'exportable'\)/);
});

test('filter dictionaries use their own authenticated no-store endpoint', async () => {
  const [page, form, endpoint] = await Promise.all([
    read('app/(admin)/admin/employees/page.tsx'),
    read('components/admin/attestations-filter-form.tsx'),
    read('app/api/admin/attestations/filters/route.ts'),
  ]);
  assert.doesNotMatch(page, /result\.data\.(?:organizations|courses)/);
  assert.match(form, /\/api\/admin\/attestations\/filters/);
  assert.match(form, /dictionaries\.organizations/);
  assert.match(form, /dictionaries\.courses/);
  assert.match(endpoint, /getAdminAttestationFilters/);
  assert.match(endpoint, /@\/lib\/security\/api-response/);
  assert.match(endpoint, /private, no-store/);
  assert.match(endpoint, /Vary: 'Cookie'/);
});

test('attestation mutations have narrow capability checks and bounded targets', async () => {
  const [server, route, migration] = await Promise.all([
    read('features/admin/attestations.ts'),
    read('app/api/admin/attestations/actions/route.ts'),
    read('supabase/migrations/20260818030000_idempotent_attestation_actions.sql'),
  ]);
  assert.match(route, /requireCapability\(/);
  assert.match(route, /'identity\.manage'/);
  assert.match(route, /'certificate\.issue'/);
  assert.match(route, /'certificate\.revoke'/);
  assert.match(route, /executeAdminAttestationAction/);
  assert.match(server, /rpc\('execute_admin_attestation_action'/);
  assert.match(route, /max\(ADMIN_ATTESTATION_BULK_LIMIT\)/);
  assert.match(route, /z\.discriminatedUnion\('action'/);
  assert.match(route, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(migration, /for update/iu);
  assert.match(migration, /operation_receipts/);
  assert.match(server, /get_admin_work_queue/);
});

test('bulk mutation reasons accept only bounded machine tokens', async () => {
  const source = await read('features/admin/attestations.ts');
  assert.match(source, /const mutationReasonSchema/);
  assert.match(source, /\.max\(96\)/);
  assert.match(source, /\^\[A-Z\]\[A-Z0-9_\]/);
  assert.match(source, /reason: mutationReasonSchema/);
});

test('attestation screen is responsive and exposes selection, filters, and confirmed bulk actions', async () => {
  const [page, filters, manager, dialog, rowComponent, bannerComponent] = await Promise.all([
    read('app/(admin)/admin/employees/page.tsx'),
    read('components/admin/attestations-filter-form.tsx'),
    read('components/admin/attestations-manager.tsx'),
    read('components/admin/attestations-action-dialog.tsx'),
    read('components/admin/attestation-table-row.tsx'),
    read('components/admin/attestation-selection-banner.tsx'),
  ]);
  const fullManager = `${manager}\n${rowComponent}\n${bannerComponent}`;
  assert.equal(page.match(/<h1(?:\s|>)/g)?.length, 1);
  assert.match(page, /key=\{employeeHref\(query, query\.cursor\)\}/);
  for (const name of [
    'q',
    'organization',
    'course',
    'result',
    'certificate',
    'from',
    'to',
    'sort',
    'pageSize',
  ]) {
    assert.match(filters, new RegExp(`name="${name}"`));
  }
  assert.match(filters, /role=\{filtersOpen \? 'dialog' : undefined\}/);
  assert.match(filters, /@min-\[960px\]:absolute/);
  assert.match(filters, /@min-\[960px\]:right-3/);
  assert.equal((manager.match(/page\.items\.map\(\(row, index\)/g) ?? []).length, 1);
  assert.match(fullManager, /@min-\[960px\]:grid/);
  assert.match(fullManager, /@min-\[960px\]:min-h-\[56px\]/);
  assert.match(fullManager, /Выбрать все \$\{totalFiltered\} по фильтру/);
  assert.match(manager, /organizationHref\(filters, row\.organization\)/);
  assert.match(manager, /resolvedSelection\.uniquePeople/);
  assert.match(manager, /resolvedSelection\.pendingIdentity/);
  assert.match(manager, /resolvedSelection\.ready/);
  assert.match(manager, /resolvedSelection\.exportable/);
  assert.match(manager, /row\.certificateState === 'issued' && row\.certificateId/);
  assert.match(manager, /recordIds\.length > 100/);
  assert.match(manager, /\/api\/admin\/attestations\/export-jobs/);
  assert.doesNotMatch(manager, /certificateIds\.length > 100/);
  assert.match(manager, /sticky bottom-/);
  assert.match(manager, /action: 'confirm'/);
  assert.match(manager, /action: 'issue'/);
  assert.match(manager, /action: 'revoke'/);
  assert.match(manager, /\/api\/admin\/attestations\/export/);
  assert.doesNotMatch(manager, /window\.confirm/);
  assert.doesNotMatch(`${page}\n${manager}`, /количеств[ао] попыт/iu);
  assert.doesNotMatch(`${page}\n${manager}`, /истори[яю] попыт/iu);
  assert.match(dialog, /<dialog/);
  assert.match(dialog, /\.showModal\(\)/);
  assert.match(dialog, /aria-busy=\{busy \|\| undefined\}/);
});

test('attestation list keeps personal details compact and loads the avatar only on demand', async () => {
  const [page, manager, panels, rowComponent, avatarRoute, historyRoute] = await Promise.all([
    read('app/(admin)/admin/employees/page.tsx'),
    read('components/admin/attestations-manager.tsx'),
    read('components/admin/attestations-manager-panels.tsx'),
    read('components/admin/attestation-table-row.tsx'),
    read('app/api/admin/attestations/avatar/[userId]/route.ts'),
    read('app/api/admin/attestations/history/[userId]/route.ts'),
  ]);
  const managerSurface = `${manager}\n${panels}\n${rowComponent}`;
  assert.doesNotMatch(page, /createSignedUrls/);
  assert.match(page, /Найдено: \{result\.data\.total\}/u);
  assert.doesNotMatch(page, /\{result\.data\.total\} записей/u);
  assert.equal((managerSurface.match(/<ProfileAvatar/g) ?? []).length, 1);
  assert.match(managerSurface, /\/api\/admin\/attestations\/avatar\/\$\{row\.userId\}/);
  assert.equal(
    (managerSurface.match(/<AttestationWorkflowBadge row=\{row\} \/>/g) ?? []).length,
    2,
  );
  assert.doesNotMatch(managerSurface, /Нажмите, чтобы оставить только эту компанию/);
  assert.match(panels, /Сохранить данные/);
  assert.match(panels, /\/api\/admin\/users\/\$\{row\.userId\}\/identity/);
  assert.match(panels, /action: 'verify'/);
  assert.match(panels, /Имя/);
  assert.match(panels, /Фамилия/);
  assert.match(panels, /Должность/);
  assert.match(panels, /Компания/);
  assert.doesNotMatch(panels, /onEdit\('(?:name|surname|job|organization)'\)/);
  assert.match(managerSurface, />Контакт</);
  assert.match(managerSurface, /mailto:\$\{history\.email\}/);
  assert.match(historyRoute, /requireCapability\('user\.read'\)/);
  assert.match(historyRoute, /auth\.admin\.getUserById/);
  assert.match(
    avatarRoute,
    /requireAnyCapability\(\['identity\.read', 'identity\.manage'\]\)/,
  );
  assert.match(avatarRoute, /rpc\('get_profile_avatar_manifest'/);
  assert.match(avatarRoute, /isOwnedAvatarObjectKey\(/);
  assert.match(avatarRoute, /createSignedUrl\(manifest\.data\.objectKey, 10 \* 60\)/);
  assert.match(avatarRoute, /@\/lib\/security\/api-response/);
  assert.match(avatarRoute, /private, no-store/);
});

test('admin navigation makes employees the primary operational workspace', async () => {
  const [layout, dashboard, capabilities] = await Promise.all([
    read('app/(admin)/admin/layout.tsx'),
    read('app/(admin)/admin/page.tsx'),
    read('lib/security/capabilities.ts'),
  ]);
  assert.match(layout, /actor\.capabilities\.includes\('results\.read'\)[\s\S]*'\/admin\/employees'/);
  assert.match(
    layout,
    /actor\.capabilities\.includes\('results\.delete'\)[\s\S]*'\/admin\/employees\/directory'/,
  );
  assert.match(layout, /href: employeeHref, icon: Users, label: 'Сотрудники'/);
  assert.match(dashboard, /href: '\/admin\/employees\?certificate=/);
  assert.doesNotMatch(layout, /href: '\/admin\/(?:attestations|results|users|access)'/);
  assert.match(capabilities, /'certificate\.issue'/);
  assert.match(capabilities, /'results\.export'/);
});
