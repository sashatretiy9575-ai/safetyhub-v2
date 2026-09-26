import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('unified attestation read model is bounded, filterable, sorted, and cursor paginated', async () => {
  const server = await read('server/admin/attestations.ts');
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
    read('server/admin/attestations.ts'),
    read('app/api/admin/attestations/actions/route.ts'),
    read('supabase/migrations/20260818030000_idempotent_attestation_actions.sql'),
  ]);
  assert.match(route, /requireCapability\(/);
  assert.match(route, /'identity\.manage'/);
  assert.match(route, /'certificate\.issue'/);
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
  const source = await read('server/admin/attestations.ts');
  assert.match(source, /const mutationReasonSchema/);
  assert.match(source, /\.max\(96\)/);
  const definition = source.slice(source.indexOf('const mutationReasonSchema'), source.indexOf('function record'));
  const pattern = definition.match(/\.regex\(\s*\/(.+)\/u\s*,?\s*\)/u);
  assert.ok(pattern, 'reason whitelist remains an anchored regular expression');
  const whitelist = new RegExp(pattern[1], 'u');
  for (const code of ['IDENTITY_NOT_VERIFIED', 'RATE_LIMITED:60', 'DOCUMENT_PROFILE_REQUIRED', 'DOCUMENT_REQUIRED_FIELDS:education', 'DOCUMENT_REQUIRED_FIELDS:trainingReason', 'DOCUMENT_REQUIRED_FIELDS:orderNumber,orderDate,verificationKind']) assert.equal(whitelist.test(code), true, code);
  for (const unsafe of ['Database error: user@example.com', '<script>', 'DOCUMENT_REQUIRED_FIELDS:email', 'DOCUMENT_REQUIRED_FIELDS:trainingReason,secret', ' identity ', 'CODE:free text']) assert.equal(whitelist.test(unsafe), false, unsafe);
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
  assert.match(page, /key=\{employeeHref\(query, currentToken, trail\)\}/);
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
  // The panel is rendered outside the workspace container, which declares
  // container-type and would otherwise anchor `position: fixed` to the whole
  // scrollable page. Its controls therefore name the form they submit to.
  assert.match(filters, /AdminOverlay lockScroll=\{false\}/);
  assert.match(filters, /form=\{FILTER_FORM_ID\}/);
  assert.doesNotMatch(filters, /@min-\[760px\]:absolute/);
  assert.match(filters, /@min-\[760px\]:right-3/);
  assert.equal((manager.match(/page\.items\.map\(\(row, index\)/g) ?? []).length, 1);
  assert.match(fullManager, /@min-\[760px\]:grid/);
  // Spreadsheet density on the desktop sheet, with a company band that selects
  // every row of that company in one click.
  assert.match(fullManager, /@min-\[760px\]:min-h-9/);
  assert.match(manager, /aria-pressed=\{groupFullySelected\}/);
  assert.match(manager, /setOrganizationGroupSelected\(row\.organization, !groupFullySelected\)/);
  assert.match(fullManager, /Выбрать все \$\{totalFiltered\} по фильтру/);
  assert.match(manager, /organizationHref\(filters, org\)/);
  // The company band has no menu: its checkbox selects the company, and the
  // filters narrow the list to it.
  assert.doesNotMatch(manager, /Выбрать всю компанию|Показать только компанию/u);
  assert.match(manager, /resolvedSelection\.uniquePeople/);
  assert.match(manager, /resolvedSelection\.pendingIdentity/);
  assert.match(manager, /resolvedSelection\.ready/);
  assert.match(manager, /resolvedSelection\.exportable/);
  // Export eligibility is still derived from a live certificate on the row.
  assert.match(manager, /certificateState === 'issued' && Boolean\(row\.certificateId\)/);
  assert.match(manager, /recordIds\.length > 100/);
  assert.match(manager, /\/api\/admin\/attestations\/export-jobs/);
  assert.doesNotMatch(manager, /certificateIds\.length > 100/);
  assert.match(manager, /sticky bottom-/);
  assert.match(manager, /action: 'confirm'/);
  assert.match(manager, /action: 'issue'/);
  // Manual revocation is gone from the product; deletion is its own bulk route.
  assert.doesNotMatch(manager, /action: 'revoke'/);
  assert.match(manager, /\/api\/admin\/users\/purge/);
  assert.match(manager, /\/api\/admin\/attestations\/export/);
  // Several company bands accumulate and leave the browser as one archive per
  // company; the metadata is still fetched once for the whole selection.
  assert.match(manager, /unionAttestationSelections/);
  assert.match(manager, /groupBy: 'organization'/);
  assert.match(manager, /по одному на компанию/);
  assert.match(manager, /setOrganizationGroupSelected\(\s*row\.organization,\s*true,\s*'replace',/);
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
  assert.equal((managerSurface.match(/<AttestationWorkflowBadge row=\{row\}/g) ?? []).length, 2);
  assert.doesNotMatch(managerSurface, /Нажмите, чтобы оставить только эту компанию/);
  assert.match(panels, /Сохранить данные/);
  assert.match(panels, /\/api\/admin\/users\/\$\{row\.userId\}\/identity/);
  assert.match(panels, /action: 'verify'/);
  assert.match(panels, /Имя/);
  assert.match(panels, /Фамилия/);
  assert.match(panels, /Должность/);
  assert.match(panels, /Компания/);
  assert.doesNotMatch(panels, /onEdit\('(?:name|surname|job|organization)'\)/);
  assert.match(managerSurface, /mailto:\$\{contact\.email\}/);
  // The card shows the phone and a WhatsApp button as soon as it opens, for
  // every row, so the number and the address come from their own endpoint
  // rather than riding on the certificate history that a deleted course lacks.
  const contactRoute = await read('app/api/admin/attestations/contact/[userId]/route.ts');
  assert.match(managerSurface, /\/api\/admin\/attestations\/contact\/\$\{row\.userId\}/);
  // The owner's rules: no captions over the contact details, no mail button,
  // and never a sentence claiming the phone is optional.
  assert.doesNotMatch(managerSurface, />(?:Контакт|Телефон)</u);
  assert.doesNotMatch(managerSurface, />Письмо<|необязателен при регистрации/u);
  // The owner asked twice for the mail button to go: the address is the one
  // `mailto:` link pinned above, and nothing else in the card writes to it.
  assert.doesNotMatch(managerSurface, /Написать на почту/u);
  assert.equal((managerSurface.match(/mailto:/gu) ?? []).length, 1);
  // The position stands beside the company instead of being the only line of
  // a collapsed section, and the name is the card's heading alone.
  assert.doesNotMatch(panels, /<details[\s\S]{0,400}Дополнительные сведения/u);
  assert.doesNotMatch(panels, /Дополнительные сведения/u);
  assert.match(panels, /Должность: \{row\.job \|\| 'не указана'\}/u);
  assert.doesNotMatch(panels, /<p[^>]*>\{row\.fullName\}<\/p>/u);
  // The way into the form is not a toggle any more: the form has its own
  // «Отмена», so the button never says one thing and announces another.
  assert.doesNotMatch(panels, /Закрыть редактирование|aria-pressed=\{mode === 'edit'\}/u);
  // A link is only built from a number it can dial; anything else is text.
  assert.match(panels, /isDialablePhone\(contact\.phoneE164\)/u);
  assert.match(panels, /Телефон не указан/u);
  assert.match(panels, /role="group"\s+aria-label="Связаться"/u);
  // The photo is a plain <img> over initials that are always there, asked for
  // at once: Radix kept the fallback hidden while a lazy image was pending.
  assert.doesNotMatch(panels, /AvatarImage|@\/components\/ui\/avatar/u);
  assert.doesNotMatch(panels, /loading="lazy"/u);
  assert.match(panels, /fetchPriority="high"/u);
  assert.match(panels, /onError=\{\(\) => setPhotoState\('failed'\)\}/u);
  assert.match(panels, /title="Открыть фото"/u);
  // The card's lazy chunk is fetched while the browser is idle, and every read
  // in the card is bounded: a raw `fetch` left the education field disabled
  // for good when the answer never came.
  assert.match(
    panels,
    /export const preloadAttestationCard = \(\) => \{\s*void import\('@\/components\/admin\/course-access-control'\);\s*void import\('@\/components\/admin\/person-document-fields'\);\s*\};/u,
  );
  // The card edits what the protocol prints about the person — the category and
  // the note — in place; it no longer sends anybody to a separate editor.
  assert.match(panels, /<PersonDocumentFields[\s\S]{0,160}userId=\{row\.userId\}[\s\S]{0,80}courseId=\{row\.testId\}/u);
  assert.doesNotMatch(`${panels}
${manager}`, /\/admin\/settings\/certificate/u);
  assert.match(manager, /window\.requestIdleCallback\(preloadAttestationCard\)/u);
  assert.match(manager, /window\.setTimeout\(preloadAttestationCard, /u);
  assert.doesNotMatch(panels, /(?:void|await)\s+fetch\s*\(/u);
  // A refused save says what was refused.
  assert.match(panels, /Данные сотрудника не сохранены\. \$\{clientRequestMessage\(/u);
  assert.match(
    panels,
    /result\.error\.status === 400\s*\?\s*'Данные сотрудника не сохранены: сервер отклонил значения полей\. Проверьте имя, фамилию, должность и компанию\.'/u,
  );
  assert.doesNotMatch(panels, /Не удалось сохранить данные/u);
  // Two administrators on one card: the save names the identity version it
  // was opened on, and the route compares it after the quota and before the
  // write, so the second save is refused instead of overwriting the first.
  const [identityRoute, identityValidation] = await Promise.all([
    read('app/api/admin/users/[userId]/identity/route.ts'),
    read('lib/validation/identity.ts'),
  ]);
  assert.match(
    identityValidation,
    /expectedVersion: z\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\)/u,
  );
  assert.match(identityRoute, /current\.version !== parsedBody\.data\.expectedVersion/u);
  assert.match(identityRoute, /\{ error: 'IDENTITY_CHANGED' \}, \{ status: 409 \}/u);
  const quotaAt = identityRoute.indexOf('await consumeAdminMutationQuota');
  const conflictAt = identityRoute.indexOf("'IDENTITY_CHANGED'");
  const writeAt = identityRoute.indexOf('await verifyUserIdentity(');
  assert.ok(quotaAt >= 0 && quotaAt < conflictAt && conflictAt < writeAt);
  assert.match(panels, /expectedVersion: versionRef\.current/u);
  assert.match(panels, /payload\?\.error === 'IDENTITY_CHANGED'/u);
  assert.match(panels, /их уже изменил другой администратор/u);
  assert.match(panels, /Показать актуальные/u);
  // An issuance refused for the person's own data keeps the card open on the
  // fields at fault; the document profile calls the position `position`.
  assert.match(manager, /position: 'job'/u);
  assert.match(
    manager,
    /message: `Сертификат не выдан: \$\{skipReasonLabel\(only\?\.reason\)\}\.`/u,
  );
  assert.match(panels, /if \(issue && canEdit\) setMode\('edit'\)/u);
  assert.match(panels, /invalid=\{issueFields\.includes\(field\)\}/u);
  assert.match(panels, /\[aria-invalid="true"\]:enabled/u);
  // What was typed and not saved survives closing the card, and «Отмена» and a
  // successful save are what drop it.
  assert.match(panels, /canEdit && \(issue \|\| getDraft\(row\.recordId\)\) \? 'edit' : 'view'/u);
  assert.match(panels, /onDraft\(row\.recordId, null\);\s*\n\s*setMode\('view'\);/u);
  assert.match(panels, /onDraft\(null\);\s*\n\s*onSaved\(row, normalized\);/u);
  assert.match(managerSurface, /phoneHref\(contact\.phoneE164\)/);
  assert.match(managerSurface, /formatPhoneDisplay\(contact\.phoneE164\)/);
  assert.match(
    managerSurface,
    /whatsappChatHref\(contact\.phoneE164\)/,
  );
  assert.match(managerSurface, /target="_blank"\s+rel="noopener noreferrer"/);
  assert.match(managerSurface, /WhatsApp/);
  assert.match(contactRoute, /requireCapability\('user\.read'\)/);
  assert.match(contactRoute, /rpc\('get_safe_user_email'/);
  assert.match(contactRoute, /\.from\('profiles'\)/);
  assert.match(contactRoute, /select\('phone_e164, phone_country_iso2'\)/);
  assert.match(contactRoute, /@\/lib\/security\/api-response/);
  assert.match(historyRoute, /requireCapability\('user\.read'\)/);
  // Both service-role reads of one person spend the operator's budget, after
  // the capability check and before any database read.
  for (const route of [contactRoute, historyRoute]) {
    assert.match(
      route,
      /const actor = await requireCapability\('user\.read'\);[\s\S]*?await consumeBusinessQuota\('admin\.pii\.read', actor\.user\.id\);[\s\S]*createAdminClient\(\)/u,
    );
  }
  // The card reads the address from the contact endpoint above, so the history
  // payload carries certificates only: no address lookup of any kind is left.
  assert.doesNotMatch(historyRoute, /get_safe_user_email|\bemail\b/);
  assert.doesNotMatch(historyRoute, /auth\.admin\.getUserById/);
  assert.match(avatarRoute, /requireAnyCapability\(\['identity\.read', 'identity\.manage'\]\)/);
  assert.match(avatarRoute, /rpc\('get_profile_avatar_manifest'/);
  assert.match(avatarRoute, /isOwnedAvatarObjectKey\(/);
  // The route streams the photo itself and revalidates it by ETag, so no
  // signed Storage URL is minted for the card any more.
  assert.doesNotMatch(avatarRoute, /createSignedUrl|redirect\(/);
  assert.match(avatarRoute, /createPrivateRevalidatedResponse\(/);
  assert.match(avatarRoute, /@\/lib\/security\/api-response/);
});

test('admin navigation makes employees the primary operational workspace', async () => {
  const [layout, dashboard, capabilities] = await Promise.all([
    read('app/(admin)/admin/layout.tsx'),
    read('app/(admin)/admin/page.tsx'),
    read('lib/security/capabilities.ts'),
  ]);
  assert.match(
    layout,
    /actor\.capabilities\.includes\('results\.read'\)[\s\S]*'\/admin\/employees'/,
  );
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
