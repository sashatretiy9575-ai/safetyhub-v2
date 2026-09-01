import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceRoots = ['app', 'components', 'features', 'i18n', 'lib', 'messages'];
const sourceExtensions = ['.ts', '.tsx', '.js', '.mjs', '.json'];
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(path.join(repositoryRoot, directory), {
    withFileTypes: true,
  })) {
    const relative = path.join(directory, entry.name).replaceAll('\\', '/');
    if (entry.isDirectory()) result.push(...(await listFiles(relative)));
    else if (sourceExtensions.includes(path.extname(entry.name))) result.push(relative);
  }
  return result;
}

async function resolveLocalModule(fromFile, specifier) {
  const unresolved = specifier.startsWith('@/')
    ? path.join(repositoryRoot, specifier.slice(2))
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(path.join(repositoryRoot, fromFile)), specifier)
      : null;
  if (!unresolved) return null;

  const candidates = [
    unresolved,
    ...sourceExtensions.map((extension) => `${unresolved}${extension}`),
    ...sourceExtensions.map((extension) => path.join(unresolved, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return path.relative(repositoryRoot, candidate).replaceAll('\\', '/');
      }
    } catch {
      // Try the next supported TypeScript/JavaScript resolution candidate.
    }
  }
  return null;
}

function imports(source) {
  const values = new Set();
  for (const match of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;]*?\s+from\s+['"]([^'"]+)['"]/gmu,
  )) {
    // A type-only import is erased by TypeScript and cannot put the referenced
    // server module in a browser bundle. Following it would turn this into a
    // false positive for a server-only module used solely as a type contract.
    if (!match[1]) values.add(match[2]);
  }
  for (const match of source.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/gmu)) {
    values.add(match[1]);
  }
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/gmu)) {
    values.add(match[1]);
  }
  return [...values];
}

function sourceBetween(source, start, end) {
  const startAt = source.indexOf(start);
  assert.ok(startAt >= 0, `missing ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.ok(endAt >= 0, `missing ${end} after ${start}`);
  return source.slice(startAt, endAt);
}

test('client import graph cannot reach reproducible seed or snapshot source files', async () => {
  const files = (await Promise.all(sourceRoots.map(listFiles))).flat();
  const sourceByFile = new Map(
    await Promise.all(files.map(async (file) => [file, await read(file)])),
  );
  const clientEntries = files.filter((file) =>
    /^['"]use client['"];?/u.test(sourceByFile.get(file)),
  );
  const visited = new Set();
  const pending = [...clientEntries];

  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = sourceByFile.get(file);
    assert.ok(source, `missing source for ${file}`);

    // Next.js compiles an imported `use server` module into an action proxy;
    // its implementation and transitive dependencies are not browser code.
    // Do not follow that boundary when checking the client import graph.
    if (/^['"]use server['"];?/u.test(source)) continue;

    assert.doesNotMatch(
      source,
      /content[\\/](?:snapshots|localizations)|supabase[\\/]seed\.sql/iu,
      file,
    );
    assert.doesNotMatch(source, /['"](?:node:)?fs(?:[\\/][^'"]*)?['"]/u, file);
    assert.doesNotMatch(source, /import\s+['"]server-only['"]/u, file);

    for (const specifier of imports(source)) {
      const resolved = await resolveLocalModule(file, specifier);
      if (resolved) pending.push(resolved);
    }
  }

  assert.ok(clientEntries.length > 0);
  assert.ok(visited.has('components/admin/test-editor.tsx'));
  assert.ok(visited.has('components/quiz/quiz-client.tsx'));
});

test('public assets and public course rendering exclude snapshots, answer keys and storage paths', async () => {
  const [topicSource, topicPage, learnerServer, learnerTypes] = await Promise.all([
    read('lib/content/topics.ts'),
    read('app/(public)/topics/[slug]/page.tsx'),
    read('features/learning/server.ts'),
    read('features/learning/types.ts'),
  ]);
  assert.match(topicSource, /^import 'server-only';/u);
  assert.match(topicSource, /function topicFromLocalRecord/u);
  assert.doesNotMatch(topicSource, /return\s+raw\s*;/u);
  assert.doesNotMatch(
    topicPage,
    /correctOption|questionVariants|variants|storagePath|thumbnailPath/iu,
  );
  assert.doesNotMatch(
    learnerServer,
    /correctOptionId|test_revision_variant_answer_keys|reviewItemSchema/u,
  );
  assert.doesNotMatch(learnerTypes, /correctOptionId|variantId|variantNumber|review:/u);

  async function publicFiles(directory = 'public') {
    const entries = await readdir(path.join(repositoryRoot, directory), { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) result.push(...(await publicFiles(relative)));
      else result.push(relative.replaceAll('\\', '/'));
    }
    return result;
  }
  const publicFilesList = await publicFiles();
  assert.equal(
    publicFilesList.some((file) =>
      /(?:course\.json|presentation-manifest\.json|presentation\.pdf|seed\.sql)$/u.test(file),
    ),
    false,
  );
});

test('previously persisted assessment keys have no browser editor or RPC read path', async () => {
  const [editor, editPage, adminServer, courseRoute, migration, contract] = await Promise.all([
    read('components/admin/test-editor.tsx'),
    read('app/(admin)/admin/courses/[id]/page.tsx'),
    read('features/admin/server.ts'),
    read('app/api/admin/courses/route.ts'),
    read('supabase/migrations/20260831116000_retire_browser_editor_key_reads.sql'),
    read('supabase/tests/course_catalog_v3.sql'),
  ]);
  const seed = sourceBetween(
    adminServer,
    'export async function getTestEditorSeed',
    'export async function saveTest',
  );

  assert.match(editPage, /getTestEditorSeed/);
  assert.doesNotMatch(editPage, /getTestEditorPayload|TestEditorPayload/u);
  assert.match(editor, /freshTestFromSeed/);
  assert.match(editor, /questionVariants: empty\.questionVariants/);
  assert.match(editor, /data-course-editor-key-boundary/);
  assert.doesNotMatch(editor, /readTestEditorDraft|writeTestEditorDraft|clearTestEditorDraft/u);
  assert.doesNotMatch(editor, /localStorage\.getItem|localStorage\.setItem/u);
  const saveResult = sourceBetween(
    adminServer,
    'export async function saveTest',
    'export async function setTestStatus',
  );
  assert.match(
    saveResult,
    /return \{\s*id: saved\.id,\s*slug: saved\.slug,\s*draftVersion: saved\.draftVersion,\s*contentHash: saved\.contentHash,\s*\};/u,
  );
  assert.doesNotMatch(saveResult, /return saved;/u);
  assert.match(courseRoute, /const result = await saveTest\(parsed\.data\);/u);
  assert.match(courseRoute, /NextResponse\.json\(result,/u);
  for (const privateField of [
    'get_course_editor_payload_v3',
    'question_variants',
    'correctOptionId',
    'explanation',
    'variantNumber',
    'storage_bucket',
    'storage_path',
    'thumbnail_path',
    'source_filename',
  ]) {
    assert.doesNotMatch(seed, new RegExp(privateField, 'u'), privateField);
  }
  assert.match(migration, /revoke all on function public\.get_test_editor_payload\(uuid,uuid\)/u);
  assert.match(
    migration,
    /revoke all on function public\.get_test_editor_payload_v2\(uuid,uuid\)/u,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_course_editor_payload_v3\(uuid,uuid\)/u,
  );
  assert.match(
    contract,
    /or has_function_privilege\(\s*'authenticated', 'public\.get_course_editor_payload_v3\(uuid,uuid\)'/u,
  );
  assert.match(
    contract,
    /or has_function_privilege\(\s*'service_role', 'public\.get_course_editor_payload_v3\(uuid,uuid\)'/u,
  );
});

test('presentation finalize responses retain no immutable storage path in the browser', async () => {
  const [types, finalizeRoute, presentationInput] = await Promise.all([
    read('features/admin/types.ts'),
    read('app/api/admin/courses/[courseId]/presentation/finalize/route.ts'),
    read('components/admin/course-presentation-input.tsx'),
  ]);
  const response = sourceBetween(
    finalizeRoute,
    'function readyPresentationResponse',
    'function pdfSafety',
  );

  assert.doesNotMatch(types, /export type AdminPresentation[\s\S]*?(?:bucket|path|thumbnailPath)/u);
  assert.doesNotMatch(response, /bucket|path|thumbnailPath/u);
  assert.match(presentationInput, /adminPresentationUrl\(courseId, value\.id/u);
  assert.doesNotMatch(presentationInput, /value\.(?:bucket|path|thumbnailPath)/u);
});
