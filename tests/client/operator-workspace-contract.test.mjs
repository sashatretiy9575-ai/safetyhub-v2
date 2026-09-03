import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('organization directory canonicalizes aliases without silently rewriting issued snapshots', async () => {
  const [directory, cleanup, manager] = await Promise.all([
    read('supabase/migrations/20260818010000_organization_directory.sql'),
    read('supabase/migrations/20260818040000_organization_cleanup.sql'),
    read('components/admin/organization-cleanup-manager.tsx'),
  ]);
  assert.match(directory, /create table public\.organizations/);
  assert.match(directory, /create table public\.organization_aliases/);
  assert.match(directory, /organization_id uuid references public\.organizations/);
  assert.match(directory, /resolve_profile_organization/);
  assert.match(cleanup, /extensions\.similarity/);
  assert.match(cleanup, /preview_organization_merge/);
  assert.match(cleanup, /merge_organizations/);
  assert.match(cleanup, /p_reissue_certificates/);
  assert.match(cleanup, /preserved|reissued/);
  assert.match(cleanup, /if found then[\s\S]*return v_receipt\.result/);
  assert.match(cleanup, /private\.enforce_actor_quota\('admin\.attestation\.mutate'\)/);
  assert.match(manager, /Выданные PDF и их номера останутся неизменными/);
  assert.match(manager, /Старые документы будут отозваны, новые получат другие номера/);
  assert.match(manager, /requiredPhrase/);
});

test('certificate number search resolves an exact historical document', async () => {
  const workspace = await read('supabase/migrations/20260818020000_admin_work_queue.sql');
  assert.match(workspace, /get_admin_attestation_by_certificate_number/);
  assert.match(workspace, /certificate\.certificate_number = upper\(btrim/);
  assert.match(workspace, /matched_certificate_id/);
  assert.match(workspace, /matched_certificate_number/);
  assert.doesNotMatch(workspace, /like\s+['"]%/i);
});

test('materials and course editors keep primary content central and protect drafts', async () => {
  const [
    materials,
    articleEditor,
    blockEditor,
    testList,
    testStatusControls,
    testEditor,
    actionBar,
    unsavedChangesGuard,
  ] = await Promise.all([
    read('app/(admin)/admin/articles/page.tsx'),
    read('components/admin/admin-editor.tsx'),
    read('components/admin/content-block-editor.tsx'),
    read('app/(admin)/admin/courses/page.tsx'),
    read('components/admin/test-status-controls.tsx'),
    read('components/admin/test-editor.tsx'),
    read('components/admin/editor-action-bar.tsx'),
    read('components/admin/use-unsaved-changes-guard.ts'),
  ]);
  assert.match(materials, /\['all', 'Все'\]/);
  assert.match(materials, /Черновики/);
  assert.match(materials, /Опубликованные/);
  assert.match(articleEditor, /setTimeout\(\(\) => \{[\s\S]+\}, 1_500\)/);
  assert.match(articleEditor, /useUnsavedChangesGuard/);
  assert.match(articleEditor, /<EditorActionBar/);
  assert.match(actionBar, /'Просмотр'/);
  assert.match(articleEditor, /<ContentBlockEditor mode="article"/);
  assert.match(blockEditor, /draggable/);
  assert.match(blockEditor, /Переместить блок выше/);
  assert.match(blockEditor, /Блок \{index \+ 1\}/);
  assert.match(testList, />Курсы<\/h1>/);
  assert.match(testList, /min-h-16/);
  // The edit affordance carries a visible label, not just a pencil glyph.
  assert.match(testList, /<PencilSimple aria-hidden \/>\s*\n\s*Изменить/u);
  assert.match(testList, /aria-label=\{`Редактировать: \$\{course\.title\}`\}/u);
  assert.match(testStatusControls, /aria-label="В черновик"/);
  assert.match(testStatusControls, /aria-label="Удалить курс"/);
  assert.match(testStatusControls, /<NotePencil/);
  assert.match(testStatusControls, /<Trash/);
  assert.match(testStatusControls, /<DestructiveDialog/);
  assert.match(testEditor, /Черновик хранится только в памяти до отправки/);
  assert.match(testEditor, /data-course-editor-key-boundary/);
  assert.doesNotMatch(testEditor, /readTestEditorDraft|writeTestEditorDraft|clearTestEditorDraft/);
  assert.match(testEditor, /useUnsavedChangesGuard/);
  assert.match(unsavedChangesGuard, /window\.addEventListener\('beforeunload'/);
  assert.match(unsavedChangesGuard, /window\.addEventListener\('popstate'/);
  assert.match(unsavedChangesGuard, /document\.addEventListener\('click'/);
  assert.match(testEditor, /grid-cols-5/);
  assert.match(testEditor, /Основные сведения/);
  assert.match(testEditor, /<IconPicker/);
  assert.match(testEditor, /<CoursePresentationInput/);
  assert.match(testEditor, /Правила прохождения/);
  assert.doesNotMatch(testEditor, /Ревью и источники|Архивировать/);
});

test('workspace seed provides at least one hundred participants and authenticated E2E matrix', async () => {
  const [seed, e2e, packageJson] = await Promise.all([
    read('scripts/seed-operator-workspace.mjs'),
    read('e2e/authenticated-workspaces.spec.ts'),
    read('package.json'),
  ]);
  assert.match(seed, /Array\.from\(\{ length: 100 \}/);
  assert.match(seed, /Казахстанский центр промышленной/);
  assert.match(seed, /Главный специалист по координации/);
  assert.match(seed, /admin@safetyhub\.local/);
  assert.match(seed, /participant@safetyhub\.local/);
  assert.match(seed, /ALLOW_TEST_DATA/);
  assert.match(seed, /const authenticatedE2eUsers = users\.slice\(0, 2\)/);
  assert.match(
    seed,
    /from\('account_controls'\)[\s\S]*?approval_state: 'approved'[\s\S]*?authenticatedE2eUsers\.map\(\(user\) => user\.id\)/,
  );
  assert.match(seed, /\.select\('user_id,approval_state'\)/);
  assert.match(seed, /approvedE2eControls\.length !== authenticatedE2eUsers\.length/);
  assert.match(seed, /current_revision_id/);
  assert.match(seed, /variants:test_revision_variants\(id,variant_number,question_count\)/);
  for (const frozenAttemptField of [
    'test_id',
    'variant_id',
    'duration_minutes',
    'pass_score',
    'attempts_per_day',
    'reset_timezone',
  ]) {
    assert.match(seed, new RegExp(`${frozenAttemptField}:`));
  }
  assert.match(seed, /revision\.duration_minutes \* 60_000/);
  assert.match(seed, /locale: 'ru'/);
  assert.match(seed, /localized_test_title: revision\.title/);
  assert.match(seed, /ignoreDuplicates: true/);
  assert.match(seed, /onConflict: 'id'/);
  for (const [width, height] of [
    [240, 320],
    [320, 240],
    [280, 653],
    [653, 280],
    [320, 568],
    [568, 320],
    [360, 800],
    [390, 844],
    [800, 360],
    [844, 390],
    [768, 1024],
    [820, 1180],
    [1024, 1366],
    [1023, 900],
    [1024, 900],
    [1119, 900],
    [1120, 900],
    [1199, 900],
    [1200, 900],
    [1280, 720],
    [1366, 768],
    [1536, 864],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160],
  ]) {
    assert.match(e2e, new RegExp(`width: ${width}, height: ${height}`));
  }
  assert.match(e2e, /expectNoPageOverflow/);
  assert.match(e2e, /E2E_SCREENSHOT_REGRESSION/);
  assert.match(e2e, /page\.keyboard\.press\('Escape'\)/);
  assert.match(e2e, /font-size: 200%/);
  assert.match(e2e, /forcedColors: 'active'/);
  assert.match(e2e, /toBeFocused\(\)/);
  assert.match(e2e, /const learningDashboard = page\.locator\('\[data-learning-dashboard\]'\)/);
  assert.match(e2e, /learningDashboard\.getByText\(\/attempt\|попыток\|revision\|UUID\/iu\)/);
  assert.doesNotMatch(e2e, /page\.getByText\(\/attempt\|попыток\|revision\|UUID\/iu\)/);
  assert.match(e2e, /page\.locator\('#my-data'\)/);
  assert.doesNotMatch(e2e, /page\.getByText\('Мои данные'\)/);
  assert.match(packageJson, /"seed:workspace"/);
  assert.match(packageJson, /"test:e2e:auth"/);
});
