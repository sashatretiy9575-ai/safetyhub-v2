import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildContentSecurityPolicy } from '../../lib/security/content-security-policy.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

test('presentation upload uses a signed path-bound TUS grant and immutable public paths', async () => {
  const [grant, client, finalize, retire, renderValidation] = await Promise.all([
    read('app/api/admin/courses/[courseId]/presentation/upload-token/route.ts'),
    read('components/admin/course-presentation-input.tsx'),
    read('app/api/admin/courses/[courseId]/presentation/finalize/route.ts'),
    read('app/api/admin/courses/[courseId]/presentation/[presentationId]/route.ts'),
    read('lib/pdf/server-render-validation.ts'),
  ]);

  assert.match(grant, /courseId: z\.string\(\)\.uuid\(\)/);
  assert.match(grant, /createSignedUploadUrl\(pdfPath/);
  assert.match(grant, /createSignedUploadUrl\(thumbnailPath/);
  assert.match(grant, /course-presentations-staging/);
  assert.match(grant, /const uploadId = presentationId/);
  assert.match(client, /new tus\.Upload/);
  assert.match(client, /'x-signature': destination\.token/);
  assert.match(client, /findPreviousUploads/);
  assert.match(client, /resumeFromPreviousUpload/);
  assert.match(client, /setPendingFinalize\(finalizeRequest\)/);
  assert.match(client, /PresentationFinalizeError/);
  assert.match(client, /Повторить серверную проверку/);

  assert.match(finalize, /PDFDocument\.load/);
  assert.match(finalize, /renderPdfBoundaryPages\(pdfBytes, expectedPageCount\)/);
  assert.match(renderValidation, /new Set\(\[1, expectedPageCount\]\)/);
  assert.match(renderValidation, /MAX_RENDER_EDGE = 640/);
  assert.match(renderValidation, /disableWorker: true/);
  assert.match(renderValidation, /isEvalSupported: false/);
  assert.match(renderValidation, /page\.render/);
  assert.match(renderValidation, /document\.getAttachments\(\)/);
  assert.match(renderValidation, /document\.getJSActions\(\)/);
  assert.match(renderValidation, /page\.getJSActions\(\)/);
  assert.match(renderValidation, /AnnotationType\.FILEATTACHMENT/);
  assert.match(finalize, /getPageCount\(\)/);
  assert.match(finalize, /JavaScript\|JS\|Launch\|EmbeddedFile/);
  assert.match(finalize, /Filespec\|EF/);
  assert.match(finalize, /enumerateIndirectObjects\(\)/);
  assert.match(finalize, /thumbnail\.format !== 'webp'/);
  assert.match(finalize, /Math\.abs\(thumbnailRatio - 16 \/ 9\)/);
  assert.match(
    finalize,
    /const publicPrefix = `\$\{courseSegment\}\/\$\{presentationRecord\.id\}`/,
  );
  assert.match(finalize, /cacheControl: '31536000'/);
  assert.match(finalize, /status: 'rejected'/);
  assert.match(finalize, /finalize_course_presentation_metadata/);
  assert.match(finalize, /complete_course_presentation_cleanup/);
  assert.match(finalize, /COURSE_CATALOG_MAINTENANCE/);
  assert.match(finalize, /CATALOG_MAINTENANCE_REQUIRED/);
  assert.match(finalize, /presentationRecord\.status === 'ready'[\s\S]*commitPresentationMetadata/);
  assert.match(finalize, /\['staging', 'validating'\]\.includes\(presentationRecord\.status\)/);
  assert.match(finalize, /uploadedPublicAssetsMatch/);
  assert.match(finalize, /byteArraysEqual/);
  assert.match(finalize, /replayed: true/);
  assert.ok(
    finalize.indexOf("presentationRecord.status === 'ready'") <
      finalize.indexOf("!['staging', 'validating'].includes(presentationRecord.status)"),
  );
  assert.match(finalize, /storage\s*\.from\(STAGING_BUCKET\)\s*\.remove/s);
  const publicUpload = finalize.indexOf('const [pdfUpload, thumbnailUpload]');
  const metadataCommit = finalize.indexOf('const metadata = await commitPresentationMetadata');
  const stagingCleanup = finalize.indexOf(
    'await cleanupFinalizedStaging(admin, metadata.payload.cleanup)',
    metadataCommit,
  );
  assert.ok(publicUpload >= 0 && publicUpload < metadataCommit && metadataCommit < stagingCleanup);
  assert.doesNotMatch(finalize, /storage_bucket: PUBLIC_BUCKET/);
  assert.match(finalize, /if \(rejected\.data\)[\s\S]*storage\.from\(STAGING_BUCKET\)\.remove/);
  assert.match(client, /upload\.abort\(true\)/);
  assert.match(client, /DOMException\('UPLOAD_ABORTED', 'AbortError'\)/);
  assert.match(client, /if \(cancelled\) return/);
  assert.match(retire, /retireCoursePresentation\(/);
  assert.doesNotMatch(retire, /\.storage\s*\.from/);
  assert.doesNotMatch(retire, /\.from\('course_presentations'\)/);
});

test('catalog cutover API is same-origin, capability-gated, bounded and RPC-envelope aware', async () => {
  const [prepareRoute, activateRoute, maintenanceRoute, validation, server] = await Promise.all([
    read('app/api/admin/course-catalog/prepare/route.ts'),
    read('app/api/admin/course-catalog/activate/route.ts'),
    read('app/api/admin/course-catalog/maintenance/route.ts'),
    read('lib/validation/admin.ts'),
    read('features/admin/server.ts'),
  ]);
  for (const route of [prepareRoute, activateRoute, maintenanceRoute]) {
    assert.match(route, /invalidOriginResponse\(request\)/);
    assert.match(route, /readJsonBody\(request, (?:16|4) \* 1024\)/);
    assert.match(route, /requireCapability\('test\.manage'\)/);
    assert.match(route, /consumeAdminMutationQuota\('admin\.test\.mutate'/);
    assert.match(route, /apiError\(error\)/);
  }
  assert.match(validation, /testIds: z\.array\(z\.string\(\)\.uuid\(\)\)\.length\(5\)/);
  assert.match(validation, /new Set\(value\.testIds\)/);
  assert.match(validation, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(server, /authenticatedRpc\('prepare_course_catalog_batch'/);
  assert.match(server, /authenticatedRpc\('activate_course_catalog_batch'/);
  assert.match(
    server,
    /activateCourseCatalogBatch[\s\S]*invalidateTestContent\(\);[\s\S]*invalidateCertificateVerificationCache\(\);/,
  );
  assert.match(server, /authenticatedRpc\('set_course_catalog_maintenance'/);
  assert.match(server, /'get_course_catalog_maintenance'/);
  assert.match(maintenanceRoute, /export async function GET\(\)/);
  assert.match(server, /authenticatedRpc\('retire_course_presentation'/);
  assert.match(server, /p_enabled: enabled/);
  assert.match(validation, /courseCatalogMaintenanceSchema/);
  assert.match(server, /p_actor_id: actor\.user\.id/);
  assert.match(server, /catalogChecksum/);
  assert.match(server, /value\.maintenanceEnabled !== true/);
  assert.match(server, /invalidateTestContent\(\)/);
  const apiErrors = await read('features/auth/api-error.ts');
  assert.match(apiErrors, /COURSE_CATALOG_MAINTENANCE'[\s\S]*status: 503/);
  assert.match(apiErrors, /CATALOG_MAINTENANCE_REQUIRED'[\s\S]*status: 409/);
});

test('catalog activation permanently retires legacy course mutation contracts', async () => {
  const migration = await read('supabase/migrations/20260825000000_course_catalog_v3.sql');
  assert.match(migration, /function private\.course_catalog_v3_active\(\)/);
  assert.match(migration, /function private\.assert_legacy_course_mutation_allowed\(\)/);
  assert.match(
    migration,
    /assert_legacy_course_mutation_allowed[\s\S]*COURSE_EDITOR_VERSION_RETIRED/,
  );
  for (const functionName of [
    'save_course_draft_v2',
    'publish_course_revision_v2',
    'save_and_publish_course_v2',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `create or replace function public\\.${functionName}[\\s\\S]*?assert_legacy_course_mutation_allowed`,
      ),
    );
  }
  assert.match(
    migration,
    /set_test_status[\s\S]*course_catalog_v3_active[\s\S]*publish_course_revision_v3_unmetered/,
  );
  assert.match(
    migration,
    /revoke execute on function public\.change_course_slug\(uuid,uuid,bigint,text\)/,
  );
});

test('course material downloads directly, stays out of precache, and precedes the test CTA', async () => {
  const [actions, topicPage, localAsset, serviceWorker, csp] = await Promise.all([
    read('components/topics/course-material-actions.tsx'),
    read('app/(public)/topics/[slug]/page.tsx'),
    read('app/course-presentations/[slug]/[asset]/route.ts'),
    read('public/sw.js'),
    read('lib/security/content-security-policy.ts'),
  ]);
  assert.ok(actions.indexOf('Скачать презентацию') < actions.indexOf('Начать тест'));
  assert.match(actions, /download=\$\{encodeURIComponent/);
  assert.match(actions, /download=\{filename\}/);
  assert.match(actions, /href=\{ROUTES\.test\(course\.slug\)\}/);
  assert.doesNotMatch(actions, /pdfjs-dist|canvas|iframe|dangerouslySetInnerHTML/);
  assert.match(topicPage, /<CourseMaterialActions course=\{topic\}/);
  assert.doesNotMatch(topicPage, /CoursePresentationViewer/);
  assert.match(localAsset, /Accept-Ranges': 'bytes'/);
  assert.match(localAsset, /Content-Range/);
  assert.match(localAsset, /MAX_RANGE_BYTES = 2 \* 1024 \* 1024/);
  assert.match(localAsset, /createReadStream/);
  assert.match(localAsset, /Content-Disposition/);
  assert.match(localAsset, /attachment; filename=/);
  assert.match(localAsset, /searchParams\.has\('download'\)/);
  assert.match(localAsset, /X-Content-Type-Options': 'nosniff'/);
  assert.doesNotMatch(localAsset, /readFile\(/);
  assert.doesNotMatch(serviceWorker, /presentation\.pdf|course-presentations/);
  assert.match(csp, /worker-src/);
  assert.doesNotMatch(buildContentSecurityPolicy({ development: false }), /unsafe-eval/);
});

test('rolling Stage-A learner parsing accepts only legacy five or canonical ten questions', async () => {
  const [server, validation, attemptRoute] = await Promise.all([
    read('features/learning/server.ts'),
    read('lib/validation/attempt.ts'),
    read('app/api/attempts/[attemptId]/route.ts'),
  ]);

  assert.match(server, /const LEGACY_QUESTION_COUNT = 5/);
  assert.match(server, /SUPPORTED_ATTEMPT_TOTALS/);
  assert.match(server, /payload\.questions\.length !== payload\.total/);
  assert.match(
    server,
    /payload\.status === 'passed' && payload\.review\.length !== payload\.total/,
  );
  assert.match(
    server,
    /payload\.total === QUIZ_POLICY\.questionCount[\s\S]*question\.options\.length !== 4/,
  );
  assert.doesNotMatch(
    server,
    /questions: z\.array\(questionSchema\)\.length\(QUIZ_POLICY\.questionCount\)/,
  );
  assert.match(
    validation,
    /length === LEGACY_QUESTION_COUNT \|\| length === QUIZ_POLICY\.questionCount/,
  );
  assert.match(
    validation,
    /new Set\(answers\.map\(\(answer\) => answer\.questionId\)\)\.size === answers\.length/,
  );
  assert.match(attemptRoute, /error instanceof AttemptPolicyError/);
  assert.match(attemptRoute, /\{ error: error\.code, retryAt: error\.retryAt \}/);
});

test('learning-history deletion is separately authorized, reasoned, idempotent and account-preserving', async () => {
  const [
    capabilities,
    validation,
    route,
    server,
    data,
    control,
    directory,
    historyPage,
    employeesPage,
    adminLayout,
    apiError,
  ] = await Promise.all([
    read('lib/security/capabilities.ts'),
    read('lib/validation/admin.ts'),
    read('app/api/admin/users/[userId]/learning-history/route.ts'),
    read('features/admin/server.ts'),
    read('features/admin/data.ts'),
    read('components/admin/learning-history-control.tsx'),
    read('app/(admin)/admin/employees/directory/page.tsx'),
    read('app/(admin)/admin/employees/[userId]/learning-history/page.tsx'),
    read('app/(admin)/admin/employees/page.tsx'),
    read('app/(admin)/admin/layout.tsx'),
    read('features/auth/api-error.ts'),
  ]);

  assert.match(capabilities, /'results\.delete'/);
  assert.match(validation, /learningHistoryDeleteSchema/);
  assert.match(validation, /confirmation: z\.literal\('УДАЛИТЬ'\)/);
  assert.match(validation, /idempotencyKey: z\.string\(\)\.uuid\(\)/);
  assert.match(route, /invalidOriginResponse\(request\)/);
  assert.match(route, /consumeAdminMutationQuota/);
  assert.match(server, /requireCapability\('results\.delete'\)/);
  assert.match(server, /get_admin_learning_history/);
  assert.match(server, /delete_admin_learning_history/);
  assert.match(server, /p_idempotency_key: idempotencyKey/);
  assert.match(data, /list_learning_history_targets_page/);
  assert.match(data, /getLearningHistoryTargetsPage[\s\S]*requireCapability\('results\.delete'\)/);
  assert.match(data, /p_actor_id: actor\.user\.id/);
  assert.match(control, /Старые\s+QR-коды перестанут работать/);
  assert.match(control, /Аккаунт и профиль сохранены/);
  assert.match(control, /crypto\.randomUUID\(\)/);
  assert.match(control, /reason\.trim\(\)\.length < 10/);
  assert.match(control, /LEARNING_HISTORY_ALREADY_DELETED/);
  assert.match(control, /Попытки: \{history\?\.counts\.attempts/);
  assert.match(directory, /getLearningHistoryTargetsPage\(query\)/);
  assert.match(directory, /actor\.capabilities\.includes\('results\.read'\)/);
  assert.match(directory, /аккаунтам и профилям/);
  assert.match(directory, /\/admin\/employees\/\$\{user\.id\}\/learning-history/);
  assert.match(historyPage, /getAdminLearningHistory\(parsed\.data\.userId\)/);
  assert.match(historyPage, /initialHistory=\{history\}/);
  assert.match(employeesPage, /\/admin\/employees\/directory/);
  assert.match(
    adminLayout,
    /actor\.capabilities\.includes\('results\.delete'\)[\s\S]*\/admin\/employees\/directory/,
  );
  assert.match(apiError, /LEARNING_HISTORY_TARGET_NOT_ALLOWED/);
});
