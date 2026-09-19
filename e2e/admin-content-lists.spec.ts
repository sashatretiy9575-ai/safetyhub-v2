import { expect, test, type Page } from '@playwright/test';

const adminStorageState = process.env.E2E_ADMIN_STORAGE_STATE;

if (process.env.E2E_REQUIRE_AUTH === '1' && !adminStorageState) {
  throw new Error('Authenticated E2E is required, but E2E_ADMIN_STORAGE_STATE is missing.');
}

// Registered unconditionally: the release gate refuses skipped tests, and a run
// without an administrator session has to fail at the login screen, not hide.
test.use({ storageState: adminStorageState });

const LISTS = [
  {
    path: '/admin/courses',
    heading: 'Курсы',
    searchLabel: 'Поиск курсов',
    statusLabel: 'Статус курса',
  },
  {
    path: '/admin/articles',
    heading: 'Материалы',
    searchLabel: 'Поиск материалов',
    statusLabel: 'Статус материала',
  },
] as const;

const PHONE_AND_DESKTOP_WIDTHS = [240, 320, 390, 1440] as const;
/** Tailwind's `sm`: from here the three controls of the panel share one line. */
const PANEL_ONE_LINE_FROM = 640;

function assertNoPageErrors(pageErrors: readonly string[]) {
  if (pageErrors.length === 0) return;
  throw new Error(
    `page threw ${pageErrors.length} uncaught error(s): ${pageErrors.join(' | ')}`.slice(0, 400),
  );
}

async function expectNoPageOverflow(page: Page, label: string) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      { message: `horizontal overflow at ${label}` },
    )
    .toBeLessThanOrEqual(0);
}

/** A key or a click that lands before React hydrates is lost, so every scenario waits for the panel. */
async function openList(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  // Scoped to the page's main region: while the response streams, React keeps the
  // segment's server HTML in a `hidden` container (`div#S:0`) before moving it into
  // place, and an unscoped locator sees that invisible copy as a second panel.
  const panel = page.locator('#admin-main [data-admin-search-panel]');
  await expect(panel).toHaveAttribute('data-client-ready', 'true', { timeout: 30_000 });
  return panel;
}

function currentHref(page: Page) {
  const url = new URL(page.url());
  return `${url.pathname}${url.search}`;
}

/**
 * Nothing in this file may change the stand. Whatever is not a read is answered
 * here with a failure and never reaches the server: the course DELETE and the
 * article server action alike, whatever address they are sent to.
 */
async function refuseEveryMutation(page: Page) {
  const refused: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      await route.fallback();
      return;
    }
    refused.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'E2E_REFUSED_MUTATION' });
  });
  return refused;
}

for (const theme of ['light', 'dark'] as const) {
  test(`content lists fit 240–1440 px without horizontal overflow in the ${theme} theme`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript((selected) => window.localStorage.setItem('theme', selected), theme);
    await page.emulateMedia({ colorScheme: theme });

    for (const list of LISTS) {
      await page.setViewportSize({ width: 1440, height: 900 });
      const panel = await openList(page, list.path);
      await expect(page.locator('html')).toHaveCSS('color-scheme', theme);

      for (const width of PHONE_AND_DESKTOP_WIDTHS) {
        const label = `${list.path} ${theme} ${width}px`;
        await page.setViewportSize({ width, height: 800 });
        await expect(page.getByRole('heading', { level: 1, name: list.heading })).toBeVisible();
        await expectNoPageOverflow(page, label);

        const search = await page.getByRole('searchbox', { name: list.searchLabel }).boundingBox();
        const status = await page.getByRole('combobox', { name: list.statusLabel }).boundingBox();
        const find = await page.getByRole('button', { name: 'Найти', exact: true }).boundingBox();
        const frame = await panel.boundingBox();
        expect(search && status && find && frame, `${label}: the panel is laid out`).toBeTruthy();
        expect(find!.width, `${label}: magnifier target`).toBeGreaterThanOrEqual(44);
        expect(find!.height, `${label}: magnifier target`).toBeGreaterThanOrEqual(44);
        expect(find!.x + find!.width, `${label}: magnifier inside the screen`).toBeLessThanOrEqual(
          width,
        );
        if (width >= PANEL_ONE_LINE_FROM) {
          expect(Math.abs(status!.y - search!.y), `${label}: one line`).toBeLessThanOrEqual(1);
        } else {
          // Below `sm` the name owns a full line; the status and the magnifier follow it.
          expect(status!.y, `${label}: status under the name`).toBeGreaterThan(search!.y);
          expect(frame!.width - search!.width, `${label}: full-width name`).toBeLessThanOrEqual(20);
        }

        // Every action of every row stays on screen, and no name is cut short.
        const geometry = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('main article')];
          return {
            rows: rows.length,
            outside: rows
              .flatMap((row) => [...row.querySelectorAll('a, button')])
              .filter((node) => {
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
              }).length,
            clipped: rows.filter((row) => {
              const name = row.querySelector('h2');
              return name !== null && name.scrollWidth > name.clientWidth + 1;
            }).length,
          };
        });
        expect(geometry.rows, `${label}: the stand has rows to measure`).toBeGreaterThan(0);
        expect(geometry.outside, `${label}: row actions outside the screen`).toBe(0);
        expect(geometry.clipped, `${label}: clipped names`).toBe(0);
      }
    }
    assertNoPageErrors(pageErrors);
  });
}

for (const list of LISTS) {
  test(`${list.path}: Enter and then the magnifier ask the list once`, async ({ page }) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await openList(page, list.path);

    // Matches nothing on purpose: the scenario is about the request, not the rows.
    const needle = `e2e-none-${Date.now()}`;
    const listRequests: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname !== list.path || url.searchParams.get('q') !== needle) return;
      // A prefetch is the router warming its cache, not the search asking for rows.
      const headers = request.headers();
      if (headers['next-router-prefetch'] || headers['next-router-segment-prefetch']) return;
      listRequests.push(`${request.method()} ${request.resourceType()}`);
    });
    // A full page load would wipe this mark: the search has to stay a client navigation.
    await page.evaluate(() => {
      (window as typeof window & { __e2eSameDocument?: boolean }).__e2eSameDocument = true;
    });

    const search = page.getByRole('searchbox', { name: list.searchLabel });
    const find = page.getByRole('button', { name: 'Найти', exact: true });
    await search.fill(needle);
    await search.press('Enter');
    await find.click();
    await expect(page).toHaveURL(`${list.path}?q=${needle}`);
    await expect(page.getByText('Ничего не найдено', { exact: true })).toBeVisible();
    await expect(page.locator('#admin-main [data-admin-search-panel]')).not.toHaveAttribute(
      'aria-busy',
      'true',
    );
    await expect(search).toHaveValue(needle);

    // The same search once more, now against the applied address.
    await find.click();
    await search.press('Enter');
    await page.waitForTimeout(750);
    expect(listRequests, 'one search is one request for the list').toHaveLength(1);
    expect(listRequests[0]).not.toContain('document');
    expect(
      await page.evaluate(
        () => (window as typeof window & { __e2eSameDocument?: boolean }).__e2eSameDocument,
      ),
    ).toBe(true);
    assertNoPageErrors(pageErrors);
  });
}

test('choosing a status sends the typed name with it, and «Сбросить» never moves the panel', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const list = LISTS[1];
  // The width at which an unreserved «Сбросить» pushed the panel a line down.
  await page.setViewportSize({ width: 390, height: 844 });
  const panel = await openList(page, list.path);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const search = page.getByRole('searchbox', { name: list.searchLabel });
  const status = page.getByRole('combobox', { name: list.statusLabel });
  const reset = page.getByRole('link', { name: 'Сбросить', exact: true });
  await expect(reset).toHaveCount(0);
  const before = await panel.boundingBox();

  const needle = `e2e-none-${Date.now()}`;
  await search.fill(needle);
  await status.selectOption('draft');
  await expect(page).toHaveURL(`${list.path}?q=${needle}&status=draft`);
  await expect(search).toHaveValue(needle);
  await expect(status).toHaveValue('draft');
  await expect(reset).toBeVisible();
  const filtered = await panel.boundingBox();
  expect(before && filtered).toBeTruthy();
  expect(Math.abs(filtered!.y - before!.y), 'the panel stays where it was').toBeLessThanOrEqual(1);
  await expectNoPageOverflow(page, 'filtered materials at 390px');

  await reset.click();
  await expect(page).toHaveURL(list.path);
  await expect(search).toHaveValue('');
  await expect(status).toHaveValue('');
  await expect(reset).toHaveCount(0);
  const cleared = await panel.boundingBox();
  expect(Math.abs(cleared!.y - before!.y), 'the panel stays where it was').toBeLessThanOrEqual(1);
});

test('«Назад» in the article editor returns to the filtered list it was opened from', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const list = LISTS[1];
  await page.setViewportSize({ width: 1280, height: 800 });
  await openList(page, list.path);

  // Filter by what the stand already has: a word of the first material and its status.
  const firstEdit = page.getByRole('link', { name: /^Редактировать:/u }).first();
  const editLabel = await firstEdit.getAttribute('aria-label');
  expect(editLabel).toBeTruthy();
  const title = editLabel!.replace(/^Редактировать:\s*/u, '');
  const needle = title
    .split(/[^\p{L}\p{N}]+/u)
    .reduce((longest, word) => (word.length > longest.length ? word : longest), '');
  expect(needle.length).toBeGreaterThan(0);
  const row = page
    .getByRole('article')
    .filter({ has: page.getByRole('link', { name: editLabel!, exact: true }) });
  const status =
    (await row.getByText('Опубликовано', { exact: true }).count()) > 0 ? 'published' : 'draft';

  await page.getByRole('searchbox', { name: list.searchLabel }).fill(needle);
  await page.getByRole('combobox', { name: list.statusLabel }).selectOption(status);
  const filteredHref = `${list.path}?${new URLSearchParams({ q: needle, status }).toString()}`;
  await expect.poll(() => currentHref(page)).toBe(filteredHref);

  await page.getByRole('link', { name: editLabel!, exact: true }).click();
  await expect(page.locator('[data-editor-shell]').filter({ visible: true })).toBeVisible({
    timeout: 60_000,
  });
  const back = page.getByRole('link', { name: 'Назад', exact: true });
  // The remembered filters join the plain address after the editor mounts.
  await expect(back).toHaveAttribute('href', filteredHref);
  await back.click();

  await expect.poll(() => currentHref(page), { timeout: 30_000 }).toBe(filteredHref);
  await expect(page.getByRole('searchbox', { name: list.searchLabel })).toHaveValue(needle);
  await expect(page.getByRole('combobox', { name: list.statusLabel })).toHaveValue(status);
  await expect(page.getByRole('link', { name: editLabel!, exact: true })).toBeVisible();
  assertNoPageErrors(pageErrors);
});

for (const scenario of [
  {
    list: LISTS[0],
    dialogTitle: (title: string) => `Удалить курс «${title}»?`,
    refusedRequest: /^DELETE \/api\/admin\/courses\/[0-9a-f-]{36}$/u,
  },
  {
    list: LISTS[1],
    dialogTitle: (title: string) => `Удалить материал «${title}»?`,
    // A server action is a POST to the page it was called from.
    refusedRequest: /^POST \/admin\/articles$/u,
  },
] as const) {
  test(`${scenario.list.path}: deleting asks first and keeps a failure inside the open dialog`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const refused = await refuseEveryMutation(page);
    const deletions = () => refused.filter((entry) => scenario.refusedRequest.test(entry));
    await page.setViewportSize({ width: 1280, height: 800 });
    await openList(page, `${scenario.list.path}?status=published`);

    const bin = page.getByRole('button', { name: /^Удалить:/u, disabled: false }).first();
    const binLabel = await bin.getAttribute('aria-label');
    expect(binLabel).toBeTruthy();
    const title = binLabel!.replace(/^Удалить:\s*/u, '');
    const rows = await page.getByRole('article').count();

    await bin.click();
    const dialog = page.getByRole('dialog', { name: scenario.dialogTitle(title) });
    await expect(dialog).toBeVisible();
    const acknowledge = dialog.getByRole('checkbox', { name: 'Подтверждаю удаление' });
    const confirm = dialog.getByRole('button', { name: 'Удалить', exact: true });
    await expect(acknowledge).not.toBeChecked();
    await expect(confirm).toBeDisabled();

    // Keyboard focus enters the dialog and stays in it. The overlay portals the
    // panel a render late; focus used to stay on the bin and Tab walked the list
    // behind the dialog, which no source-text test could notice.
    await expect(acknowledge).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Отмена' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(acknowledge).toBeFocused();

    // Enter confirms nothing while the acknowledgement is not ticked.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(acknowledge).not.toBeChecked();
    await expect(confirm).toBeDisabled();
    expect(deletions()).toEqual([]);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(bin).toBeFocused();
    await expect(bin).toHaveAttribute('aria-label', binLabel!);

    // A closed dialog forgets the tick; the refused request stays inside the reopened one.
    await bin.click();
    await expect(confirm).toBeDisabled();
    await acknowledge.check();
    await expect(confirm).toBeEnabled();
    await confirm.click();
    const alert = dialog.getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toHaveText(/\S/u);
    await expect(dialog).toBeVisible();
    await expect(confirm).toBeEnabled();
    expect(deletions()).toHaveLength(1);

    // Nothing was deleted and the filters are where they were.
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(currentHref(page)).toBe(`${scenario.list.path}?status=published`);
    await expect(page.getByRole('article')).toHaveCount(rows);
    await expect(bin).toHaveAttribute('aria-label', binLabel!);
  });
}
