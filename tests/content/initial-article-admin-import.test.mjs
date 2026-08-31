import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { articleDraftInputSchema } from '../../lib/validation/article.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');
const expectedHash = 'b7efc75f11555679d1682b26bc290c3f3b259559c427c208e0104799945c38e7';

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

test('approved initial article snapshot is exact, unique and editor-valid', async () => {
  const directory = path.join(root, 'content', 'articles');
  const filenames = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  const raw = await Promise.all(
    filenames.map(async (filename) =>
      JSON.parse(await readFile(path.join(directory, filename), 'utf8')),
    ),
  );
  assert.equal(raw.length, 10);
  assert.equal(
    createHash('sha256')
      .update(JSON.stringify(sortJson(raw)))
      .digest('hex'),
    expectedHash,
  );
  const parsed = raw.map((article, index) => {
    assert.equal(filenames[index], `${article.slug}.json`);
    return articleDraftInputSchema.parse({
      slug: article.slug,
      title: article.title,
      description: article.description,
      coverImage: article.coverImage,
      blocks: article.blocks,
      seo: article.seo,
      jurisdiction: article.jurisdiction,
      effectiveDate: article.effectiveDate,
      sources: article.sources,
    });
  });
  assert.equal(new Set(parsed.map((article) => article.slug)).size, 10);
});

test('initial article import is project-bound, confirmation-bound and uses the admin application', async () => {
  const [helper, route, page, form] = await Promise.all([
    read('lib/content/initial-article-import.ts'),
    read('app/api/admin/articles/initial-import/route.ts'),
    read('app/(admin)/admin/articles/initial-import/page.tsx'),
    read('components/admin/initial-article-import-form.tsx'),
  ]);
  assert.match(helper, /INITIAL_ARTICLE_IMPORT_PROJECT_REF = 'podkjjguhhdiecrgznoa'/);
  assert.match(helper, new RegExp(`INITIAL_ARTICLE_SNAPSHOT_HASH =\\s*'${expectedHash}'`));
  assert.match(helper, /await requireCapability\('content[.]manage'\)/);
  assert.match(helper, /configuredProjectRef\(\) !== INITIAL_ARTICLE_IMPORT_PROJECT_REF/);
  assert.match(helper, /confirmation !== INITIAL_ARTICLE_IMPORT_CONFIRMATION/);
  assert.match(helper, /await createClient\(\)/);
  assert.match(helper, /client[.]rpc\('save_and_publish_article_v2'/);
  assert.match(helper, /const before = await loadInventory\(\)/);
  assert.match(helper, /const after = await loadInventory\(\)/);
  assert.match(helper, /assertVerified\(snapshot, after\)/);
  assert.doesNotMatch(helper, /createAdminClient\(\)[\s\S]{0,160}[.](?:insert|update|delete)\(/);

  assert.match(route, /invalidOriginResponse\(request\)/);
  assert.match(route, /readJsonBody\(request, 512\)/);
  assert.match(route, /await requireCapability\('content[.]manage'\)/);
  assert.match(route, /consumeAdminMutationQuota\(\s*'content[.]article[.]mutate'/);
  assert.match(page, /await requireCapability\('content[.]manage'\)/);
  assert.match(form, /clientRequest\(\s*'\/api\/admin\/articles\/initial-import'/);
});
