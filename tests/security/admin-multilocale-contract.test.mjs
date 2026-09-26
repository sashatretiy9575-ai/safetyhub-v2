import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');
const run = promisify(execFile);

function sourceBetween(source, start, end) {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(endAt >= 0, `missing ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

test('Russian admin exposes four locale statuses and localized previews', async () => {
  const [contract, tabs, course, article, legal, adminLayout, rootLayout, proxy] =
    await Promise.all([
      read('lib/admin/localization-contract.ts'),
      read('components/admin/admin-locale-tabs.tsx'),
      read('components/admin/course-localizations-editor.tsx'),
      read('components/admin/article-localizations-editor.tsx'),
      read('components/admin/legal-localizations-editor.tsx'),
      read('app/(admin)/admin/layout.tsx'),
      read('components/layout/root-document.tsx'),
      read('proxy.ts'),
    ]);

  // The list lives in i18n/config.ts now; every schema that used to restate
  // it reads APP_LOCALES, so a fifth locale cannot be half-added.
  assert.match(contract, /ADMIN_CONTENT_LOCALES = APP_LOCALES;/u);
  for (const label of ['Не заполнено', 'Черновик', 'Готово', 'Опубликовано']) {
    assert.match(contract, new RegExp(label, 'u'));
  }
  assert.match(tabs, /role="tablist"/u);
  assert.match(tabs, /aria-selected/u);
  assert.match(tabs, /aria-controls/u);
  assert.match(tabs, /tabIndex=\{locale === activeLocale \? 0 : -1\}/u);
  assert.match(tabs, /ArrowRight/u);
  assert.match(tabs, /ArrowLeft/u);
  for (const editor of [course, article, legal]) {
    assert.match(editor, /AdminLocaleTabs/u);
    assert.match(editor, /role="tabpanel"/u);
    assert.match(editor, /Предпросмотр/u);
  }
  assert.match(course, /lang=\{item\.locale === 'zh' \? 'zh-Hans'/u);
  assert.match(article, /lang=\{activeLocale === 'zh' \? 'zh-Hans'/u);
  assert.match(legal, /lang=\{activeLocale === 'zh' \? 'zh-Hans'/u);
  assert.match(adminLayout, /data-admin-shell/u);
  assert.match(adminLayout, /Админ-панель/u);
  assert.match(rootLayout, /<html[\s\S]*?lang=\{htmlLanguage\(locale\)\}/u);
  assert.match(
    proxy,
    /localeRoutesEnabled && localizedPath\.hasLocalePrefix && localeRoutable[\s\S]*?\? localizedPath\.locale[\s\S]*?: DEFAULT_LOCALE/u,
  );
});

test('browser locale editor cannot read or submit persisted assessment identifiers or keys', async () => {
  const [component, contract, server, route, packageJson] = await Promise.all([
    read('components/admin/course-localizations-editor.tsx'),
    read('lib/admin/localization-contract.ts'),
    read('server/admin/localizations.ts'),
    read('app/api/admin/courses/[courseId]/localizations/[locale]/route.ts'),
    read('package.json'),
  ]);
  const persist = sourceBetween(
    server,
    'async function persistCourseLocalization',
    'export async function saveCourseLocalization',
  );
  const browserContract = sourceBetween(
    contract,
    'export type CourseLocalizationEditorItem',
    'export type ArticleLocalizationEditorItem',
  );

  assert.match(component, /data-course-localization-key-boundary/u);
  assert.match(component, /assessment\.variantCount/u);
  assert.match(component, /assessment\.questionCounts/u);
  assert.doesNotMatch(component, /questionVariants|variantNumber|correctOptionId|answerKey/iu);
  assert.doesNotMatch(
    contract,
    /AssessmentImport|localizedVariant|localizedQuestion|localizedOption/u,
  );
  assert.match(browserContract, /assessmentImported:\s*boolean/u);
  assert.doesNotMatch(browserContract, /translationQa|questionVariants|correctOptionId/iu);
  assert.match(persist, /p_question_variants:\s*\[\]/u);
  assert.doesNotMatch(persist, /correctOption|answer[_-]?key/iu);
  assert.doesNotMatch(route, /service[_-]?role|SUPABASE_SECRET|questionVariants/iu);
  assert.match(packageJson, /content:assessment-localization:check/u);
  assert.match(packageJson, /content:assessment-localization:import/u);
});

test('course readiness is counted on the server and only the counts reach the browser', async () => {
  const [contract, server, management, route, page, component, tabs, editor] = await Promise.all([
    read('lib/admin/localization-contract.ts'),
    read('server/admin/localizations.ts'),
    read('server/admin/management.ts'),
    read('app/api/admin/courses/[courseId]/localizations/publish/route.ts'),
    read('app/(admin)/admin/courses/[id]/page.tsx'),
    read('components/admin/course-localizations-editor.tsx'),
    read('components/admin/admin-locale-tabs.tsx'),
    read('components/admin/test-editor.tsx'),
  ]);
  const browserContract = sourceBetween(
    contract,
    'export type CourseLocalizationEditorItem',
    'export type ArticleLocalizationEditorItem',
  );
  const editorRead = sourceBetween(
    server,
    'export async function getCourseEditorLocalizations',
    'async function courseLocalizationSource',
  );
  const publisher = sourceBetween(
    server,
    'export async function publishCourseLocalizations',
    'export async function getArticleEditorLocalizations',
  );
  const seoFallback = sourceBetween(server, 'function normalizedSeo', 'function normalizedSources');
  const explanationIds = sourceBetween(
    management,
    'export async function readCourseExplanationIds',
    'export async function getTestEditorSeed',
  );

  // The browser item gains the stored SEO and four numbers, nothing textual.
  assert.match(browserContract, /seoStored:\s*\{ title: string; description: string \}/u);
  assert.match(
    browserContract,
    /assessmentGaps:\s*\{\s*total: number;\s*emptyTexts: number;\s*missingExplanations: number;\s*russianTexts: number;\s*\} \| null/u,
  );

  // The stored question sets are read and counted on the server by the shared
  // pure function; the row handed on carries the counts and not the column.
  assert.match(editorRead, /\.select\('locale,question_variants'\)/u);
  assert.match(editorRead, /readCourseExplanationIds\(courseId\)/u);
  assert.match(editorRead, /assessmentGaps:[\s\S]{0,120}courseAssessmentGaps\(row\.locale,/u);
  assert.match(editorRead, /seoStored: storedSeo\(row\.seo\)/u);
  assert.doesNotMatch(editorRead, /question_variants:|questionVariants/u);
  // A withdrawn course keeps its revision pointer; its locales are not live.
  assert.match(editorRead, /current\.data\?\.status === 'published'/u);

  // Parity with the Russian explanations travels as identifiers, through the
  // cached capability-gated bank read and outside the editor seed.
  assert.match(explanationIds, /requireCapability\('test\.manage'\)/u);
  assert.match(explanationIds, /readCourseQuestionBank\(testId, actor\.user\.id\)/u);
  assert.match(explanationIds, /\.map\(\(question\) => question\.id\)/u);
  assert.doesNotMatch(explanationIds, /correctOptionId|question\.text|options/u);

  // Russian filler is no longer handed to a translation: only the source
  // language reaches `defaultContentSeo`, and nowhere else in the module.
  assert.match(
    seoFallback,
    /if \(locale === 'ru'\) return defaultContentSeo\(title, description\);/u,
  );
  assert.equal(server.match(/defaultContentSeo\(/gu)?.length, 1);
  assert.match(
    server,
    /seo: normalizedSeo\(row\.locale, row\.seo, row\.title, row\.description\)/u,
  );
  assert.doesNotMatch(server, /normalizedSeo\(row\.seo,/u);

  // The publisher repeats the check on saved rows before the atomic RPC, and
  // the route names what it found.
  assert.ok(
    publisher.indexOf('coursePublicationBlockers(') >= 0 &&
      publisher.indexOf('coursePublicationBlockers(') <
        publisher.indexOf("authenticatedRpc('publish_course_revision_v4'"),
  );
  assert.match(publisher, /throw new CourseLocalizationsIncompleteError\(blockers\)/u);
  assert.match(route, /error: 'COURSE_LOCALIZATIONS_INCOMPLETE',/u);
  assert.match(
    route,
    /blockers: error instanceof CourseLocalizationsIncompleteError \? error\.blockers : \[\]/u,
  );
  assert.match(route, /\{ status: 409 \}/u);

  // The page computes the blockers on the server; both editors show states and
  // lines from the shared module instead of a generic sentence.
  assert.match(page, /localeBlockers=\{courseLocaleBlockers\(localizations\)\}/u);
  assert.match(tabs, /badges\?: Record<AppLocale, AdminLocaleTabBadge>/u);
  assert.match(component, /badges=\{byLocale\(\(locale\) => readiness\[locale\]\.state\)\}/u);
  assert.match(component, /courseLocaleGaps\(savedItems\[locale\], savedItems\.ru, 'bare'\)/u);
  assert.match(component, /router\.refresh\(\);/u);
  assert.doesNotMatch(component, /Статус: <strong>/u);
  assert.match(editor, /setRefusedBlockers\(refused\)/u);
  assert.match(editor, /data-course-publication-blockers/u);
  assert.doesNotMatch(editor, /подготовьте RU, KK, EN и ZH/u);
});

test('offline assessment importer accepts only strict public wording and emits a bounded receipt', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'safetyhub-locale-import-'));
  const validPath = path.join(directory, 'valid.json');
  const invalidPath = path.join(directory, 'invalid.json');
  const questionVariants = [1, 2, 3].map((variantNumber) => ({
    id: randomUUID(),
    variantNumber,
    questions: Array.from({ length: 10 }, (_, questionIndex) => ({
      id: randomUUID(),
      text: `Question ${variantNumber}.${questionIndex + 1}`,
      explanation: `Explanation ${variantNumber}.${questionIndex + 1}`,
      options: Array.from({ length: 4 }, (_, optionIndex) => ({
        id: randomUUID(),
        text: `Option ${optionIndex + 1}`,
      })),
    })),
  }));
  const bundle = {
    version: 1,
    courseId: randomUUID(),
    locale: 'en',
    expectedVersion: 1,
    questionVariants,
  };

  try {
    await writeFile(validPath, JSON.stringify(bundle), 'utf8');
    await writeFile(
      invalidPath,
      JSON.stringify({
        ...bundle,
        questionVariants: questionVariants.map((variant, variantIndex) => ({
          ...variant,
          questions: variant.questions.map((question, questionIndex) =>
            variantIndex === 0 && questionIndex === 0
              ? { ...question, correctOptionId: question.options[0].id }
              : question,
          ),
        })),
      }),
      'utf8',
    );
    const script = path.join(repositoryRoot, 'scripts/content/import-course-assessment-localization.mjs');
    const checked = await run(process.execPath, [script, '--check', '--file', validPath], {
      cwd: repositoryRoot,
      maxBuffer: 1024 * 1024,
    });
    const receipt = JSON.parse(checked.stdout);
    assert.deepEqual(receipt, {
      ok: true,
      mode: 'check',
      courseId: bundle.courseId,
      locale: 'en',
      expectedVersion: 1,
      variants: 3,
      questions: 30,
      options: 120,
    });
    await assert.rejects(
      run(process.execPath, [script, '--check', '--file', invalidPath], {
        cwd: repositoryRoot,
        maxBuffer: 1024 * 1024,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('localized presentations bind locale metadata to immutable final object paths', async () => {
  const [upload, finalize, input, types] = await Promise.all([
    read('app/api/admin/courses/[courseId]/presentation/upload-token/route.ts'),
    read('app/api/admin/courses/[courseId]/presentation/finalize/route.ts'),
    read('components/admin/course-presentation-input.tsx'),
    read('lib/admin/types.ts'),
  ]);

  assert.match(upload, /locale: z\.enum\(APP_LOCALES\)/u);
  assert.match(upload, /locale:\s*body\.data\.locale/u);
  assert.match(upload, /const prefix = `\$\{actor\.user\.id\}\/\$\{uploadId\}`/u);
  assert.match(finalize, /presentationRecord\.locale !== body\.data\.locale/u);
  assert.match(finalize, /cleanup\.locale !== expected\.locale/u);
  assert.match(
    finalize,
    /`\$\{courseSegment\}\/\$\{presentationRecord\.locale\}\/\$\{presentationRecord\.id\}`/u,
  );
  assert.match(finalize, /`\$\{publicPrefix\}\/\$\{digest\}\.pdf`/u);
  assert.match(finalize, /`\$\{publicPrefix\}\/\$\{digest\}-thumb\.webp`/u);
  assert.match(input, /locale\s*=\s*'ru'/u);
  assert.match(input, /body:\s*JSON\.stringify\(\{\s*locale,/u);
  assert.match(types, /export type AdminPresentation[\s\S]*?locale:\s*AppLocale/u);
});

test('course, article and legal publication use four-locale atomic RPCs', async () => {
  const [
    testEditor,
    articleActions,
    localizationServer,
    legalEditor,
    legalSaveRoute,
    legalBundleRoute,
    stageRoute,
  ] =
    await Promise.all([
      read('components/admin/test-editor.tsx'),
      read('server/actions/articles.ts'),
      read('server/admin/localizations.ts'),
      read('components/admin/legal-localizations-editor.tsx'),
      read('app/api/admin/legal/localizations/route.ts'),
      read('app/api/admin/legal/bundle/route.ts'),
      read('app/api/admin/legal/versions/route.ts'),
    ]);

  assert.match(testEditor, /publish:\s*false/u);
  assert.match(testEditor, /\/localizations\/publish/u);
  assert.match(testEditor, /COURSE_LOCALIZATIONS_INCOMPLETE/u);
  assert.match(articleActions, /rpc\('save_article_draft_v2'/u);
  assert.match(articleActions, /rpc\('publish_article_revision_v3'/u);
  assert.doesNotMatch(articleActions, /rpc\('save_and_publish_article_v2'/u);
  assert.match(
    articleActions,
    /return \{ \.\.\.saved, publicationError: 'ARTICLE_LOCALIZATIONS_INCOMPLETE' \}/u,
  );
  assert.match(localizationServer, /authenticatedRpc\('publish_course_revision_v4'/u);
  assert.match(localizationServer, /authenticatedRpc\('publish_article_revision_v3'/u);
  assert.match(localizationServer, /p_body_hash:\s*null/u);
  assert.match(localizationServer, /authenticatedRpc\('publish_legal_document_bundle'/u);
  assert.doesNotMatch(localizationServer, /authenticatedRpc\('publish_legal_document_localizations'/u);
  assert.match(legalEditor, /T00:00:00\+05:00/u);
  assert.match(legalEditor, /version\.current \? <Badge/u);
  assert.match(legalEditor, /updateActive\(\{ bodyHash: null \}\)/u);
  assert.match(legalEditor, /\/api\/admin\/legal\/versions/u);
  assert.match(legalEditor, /data-admin-legal-bundle-publisher/u);
  assert.match(legalEditor, /\/api\/admin\/legal\/bundle/u);
  assert.match(legalEditor, /Privacy \+ Terms/u);
  assert.doesNotMatch(
    legalEditor,
    /\/api\/admin\/legal\/localizations[\s\S]{0,180}method:\s*'POST'/u,
  );
  assert.doesNotMatch(legalSaveRoute, /export async function POST/u);
  assert.match(legalBundleRoute, /legalBundlePublicationSchema/u);
  assert.match(legalBundleRoute, /publishLegalLocalizationBundle/u);
  assert.match(legalBundleRoute, /parsed\.data\.privacyVersion/u);
  assert.match(legalBundleRoute, /parsed\.data\.termsVersion/u);
  for (const route of [legalSaveRoute, legalBundleRoute, stageRoute]) {
    assert.match(route, /invalidOriginResponse\(request\)/u);
    assert.match(route, /requireCapability\('content\.manage'\)/u);
    assert.match(route, /readJsonBody\(request,/u);
  }
});

test('admin user projections render synthetic ZH identities without exposing reserved email', async () => {
  const [data, types, approvals, directory, history] = await Promise.all([
    read('server/admin/data.ts'),
    read('lib/admin/types.ts'),
    read('components/admin/account-approval-queue.tsx'),
    read('app/(admin)/admin/employees/directory/page.tsx'),
    read('app/(admin)/admin/employees/[userId]/learning-history/page.tsx'),
  ]);

  assert.match(data, /email:\s*z\.string\(\)(?:\.email\(\))?\.nullable\(\)/u);
  assert.match(types, /email:\s*string \| null/u);
  for (const view of [approvals, directory, history]) {
    assert.match(view, /Вход по логину и паролю/u);
    assert.doesNotMatch(view, /@auth\.invalid/u);
  }
});
