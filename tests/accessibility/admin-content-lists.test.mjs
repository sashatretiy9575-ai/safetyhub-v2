import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

const LIST_PAGES = ['app/(admin)/admin/courses/page.tsx', 'app/(admin)/admin/articles/page.tsx'];

async function sourceFiles(directory) {
  const entries = await readdir(path.join(repositoryRoot, directory), { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const relative = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return sourceFiles(relative);
      return /\.(?:ts|tsx)$/u.test(entry.name) ? [relative] : [];
    }),
  );
  return nested.flat();
}

test('courses and materials are one list: the same panel, row and deletion', async () => {
  for (const file of LIST_PAGES) {
    const page = await read(file);
    for (const part of [
      'AdminListHeader',
      'AdminSearchPanel',
      'AdminListSheet',
      'AdminListRow',
      'AdminListEmpty',
      'RowDeleteAction',
    ]) {
      assert.match(page, new RegExp(`<${part}\\b`, 'u'), `${file} renders ${part}`);
    }
    // A repeated parameter arrives as an array, and `.trim()` on it threw.
    assert.match(page, /readListFilters\(await searchParams\)/u, file);
    assert.doesNotMatch(page, /params\.(?:q|status)/u, file);
    // Nothing of the two earlier layouts is left beside the shared one.
    assert.doesNotMatch(page, /<form|<Input|<article|grid-cols-|Открыть на сайте|Найти/u, file);
  }

  // Taking a course off the site moved into its editor; the row only deletes.
  await assert.rejects(
    access(path.join(repositoryRoot, 'components/admin/test-status-controls.tsx')),
  );
  for (const file of [...(await sourceFiles('app')), ...(await sourceFiles('components'))]) {
    assert.doesNotMatch(await read(file), /TestStatusControls|test-status-controls/u, file);
  }
});

test('the search panel is a real form of three controls that asks the list once', async () => {
  const panel = await read('components/admin/admin-search-panel.tsx');
  // Without JavaScript the browser still sends the same GET.
  assert.match(panel, /<form\s+action=\{basePath\}\s+method="get"/u);
  assert.match(panel, /type="search"\s+name="q"/u);
  assert.match(panel, /maxLength=\{ADMIN_LIST_QUERY_MAX\}/u);
  assert.match(panel, /placeholder="Поиск по названию"/u);
  assert.match(
    panel,
    /<AdminFilterSelect name="status" value=\{selected\} aria-label=\{statusLabel\}>/u,
  );
  assert.match(panel, /<Button type="submit" size="icon" aria-label="Найти" title="Найти">/u);
  assert.equal(panel.match(/<(?:Input|AdminFilterSelect|Button)\b/gu)?.length, 3);

  // No frame around framed controls, and the name keeps a full line below `sm`.
  const formClass = panel.match(/onSubmit=\{submit\}\s+className="([^"]+)"/u)?.[1] ?? '';
  assert.match(formClass, /^grid grid-cols-\[minmax\(0,1fr\)_auto\] gap-2 /u);
  assert.match(formClass, /sm:grid-cols-\[minmax\(0,1fr\)_12rem_auto\]/u);
  assert.doesNotMatch(formClass, /(?:^|\s)border(?:-|\s|$)/u);
  assert.match(panel, /className="col-span-2 sm:col-span-1"/u);

  // One navigation per search: the applied and the pending address are skipped.
  assert.match(panel, /event\.preventDefault\(\);/u);
  assert.match(
    panel,
    /if \(target === \(sent\?\.href \?\? listHref\(basePath, appliedQuery\)\)\) return;/u,
  );
  assert.match(
    panel,
    /startTransition\(\(\) => router\.replace\(target, \{ scroll: false \}\)\);/u,
  );
  // The spinner replaces the magnifier inside the same icon button.
  assert.match(panel, /aria-busy=\{isPending \|\| undefined\}/u);
  assert.match(panel, /isPending \? \(\s*<SpinnerGap aria-hidden className="animate-spin/u);
  // The name field gives way to the applied name only, never to a plain re-render.
  assert.match(panel, /if \(applied\.q !== q && /u);
  assert.doesNotMatch(panel, /defaultValue/u);
  // The editor's way back reads what the list stored.
  assert.match(panel, /rememberAdminListQuery\(basePath, appliedQuery\)/u);
});

test('a list row wraps its name, shares one column template and keeps two actions', async () => {
  const list = await read('components/admin/admin-list.tsx');
  assert.doesNotMatch(list, /^'use client'/u);
  assert.equal(list.match(/md:grid-cols-\[/gu)?.length, 1);
  assert.match(list, /md:grid-cols-\[minmax\(0,2fr\)_11rem_8rem_auto\]/u);
  assert.equal(list.match(/\$\{SHEET_COLUMNS\}/gu)?.length, 2);
  assert.doesNotMatch(list, /col-start-|row-start-|1\.5fr/u);

  const heading = list.match(/<h2 className="([^"]+)">/u)?.[1] ?? '';
  assert.match(heading, /(?:^|\s)break-words(?:\s|$)/u);
  assert.match(heading, /\[overflow-wrap:anywhere\]/u);
  assert.doesNotMatch(heading, /truncate|line-clamp/u);
  assert.doesNotMatch(list, /<h2[^>]*\stitle=/u);

  // DOM order: the name, the status, the date, the actions.
  const order = ['<h2 ', '{badges}', '<Updated value={updatedAt} withTime />', '{actions}'].map(
    (needle) => list.indexOf(needle),
  );
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.match(list, /tabular-nums md:hidden/u);

  assert.match(list, /Ничего не найдено/u);
  assert.doesNotMatch(list, /Открыть на сайте|ArrowSquareOut|Archive/u);
  // «Сбросить» is a link only while a filter is applied, and its place is kept:
  // the same button box, invisible, so the panel below never moves.
  assert.match(list, /resetHref \? \(/u);
  assert.match(list, /className="px-2">[\s\S]*?<Link href=\{resetHref\} replace>\s*Сбросить/u);
  assert.match(list, /className="invisible px-2">\s*<span aria-hidden="true">Сбросить<\/span>/u);
});

test('deleting from a row says what the database does and fails inside the dialog', async () => {
  const [action, editor, articles, migration] = await Promise.all([
    read('components/admin/row-delete-action.tsx'),
    read('components/admin/admin-editor.tsx'),
    read('app/(admin)/admin/articles/page.tsx'),
    read('supabase/migrations/20260820000000_content_lifecycle_additive.sql'),
  ]);
  assert.match(action, /variant="dangerGhost"/u);
  assert.match(action, /title="Удалить"/u);
  assert.match(action, /disabled=\{busy \|\| expectedVersion === null\}/u);
  assert.match(action, /clientRequest\(`\/api\/admin\/courses\/\$\{id\}`, \{\s*method: 'DELETE'/u);
  assert.match(action, /body: JSON\.stringify\(\{ expectedVersion \}\)/u);
  assert.match(action, /deleteArticleAction\(\{ articleId: id, expectedVersion \}\)/u);
  // A failure keeps the dialog open; only a deletion closes it and refreshes in place.
  assert.match(
    action,
    /if \(failure\) \{\s*setError\(failure\);\s*return;\s*\}\s*setOpen\(false\);\s*router\.refresh\(\);/u,
  );
  assert.match(action, /error=\{error\}/u);
  assert.doesNotMatch(action, /router\.(?:push|replace)/u);

  assert.match(action, /Удалить курс «\$\{name\}»\?/u);
  assert.match(
    action,
    /Курс исчезнет с сайта на всех языках\. Удалятся презентации, вопросы, попытки, аттестации и выданные доступы\. Выданные сертификаты сохранятся\./u,
  );
  assert.match(action, /Удалить материал «\$\{name\}»\?/u);
  assert.match(
    action,
    /Материал исчезнет с сайта на всех языках, ссылка перестанет открываться\. Черновик, переводы и история редакций удалятся\./u,
  );
  // The copy above promises exactly this.
  assert.match(migration, /course_deleted_at = v_deleted_at/u);
  assert.match(migration, /delete from public\.tests where id = p_test_id/u);
  assert.match(migration, /delete from public\.articles where id = p_article_id/u);

  // The article editor asks with the same words, shows its failure inside the
  // dialog and returns to the list as it was left.
  assert.match(editor, /\{\.\.\.deleteDialogCopy\('article', title\)\}/u);
  assert.match(editor, /error=\{deleteError\}/u);
  assert.match(editor, /const listHref = useAdminListHref\('\/admin\/articles'\);/u);
  assert.match(editor, /<Link href=\{listHref\}>Назад<\/Link>/u);
  assert.match(editor, /router\.replace\(listHref\);/u);
  assert.doesNotMatch(editor, /(?:href=|router\.replace\()["']\/admin\/articles["']/u);

  // The list RPC has no draft version; one narrow read supplies it to the bin.
  assert.match(
    articles,
    /\.from\('article_drafts'\)\s*\.select\('article_id,draft_version'\)\s*\.in\('article_id', ids\)/u,
  );
  assert.match(articles, /expectedVersion=\{draftVersions\.get\(article\.id\) \?\? null\}/u);
});
