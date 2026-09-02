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
      read('features/admin/localization-contract.ts'),
      read('components/admin/admin-locale-tabs.tsx'),
      read('components/admin/course-localizations-editor.tsx'),
      read('components/admin/article-localizations-editor.tsx'),
      read('components/admin/legal-localizations-editor.tsx'),
      read('app/(admin)/admin/layout.tsx'),
      read('app/layout.tsx'),
      read('proxy.ts'),
    ]);

  assert.match(contract, /\[\s*'ru',\s*'kk',\s*'en',\s*'zh',?\s*\]/u);
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
  assert.match(rootLayout, /<html lang=\{htmlLanguage\(locale\)\}/u);
  assert.match(
    proxy,
    /localeRoutesEnabled && localizedPath\.hasLocalePrefix && localeRoutable[\s\S]*?\? localizedPath\.locale[\s\S]*?: DEFAULT_LOCALE/u,
  );
});

test('browser locale editor cannot read or submit persisted assessment identifiers or keys', async () => {
  const [component, contract, server, route, packageJson] = await Promise.all([
    read('components/admin/course-localizations-editor.tsx'),
    read('features/admin/localization-contract.ts'),
    read('features/admin/localizations-server.ts'),
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
    const script = path.join(repositoryRoot, 'scripts/import-course-assessment-localization.mjs');
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
    read('features/admin/types.ts'),
  ]);

  assert.match(upload, /locale:\s*z\.enum\(\['ru', 'kk', 'en', 'zh'\]\)/u);
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
      read('lib/actions/articles.ts'),
      read('features/admin/localizations-server.ts'),
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
    read('features/admin/data.ts'),
    read('features/admin/types.ts'),
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
