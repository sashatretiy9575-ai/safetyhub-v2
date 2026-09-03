import { expect, test, type Page, type TestInfo } from '@playwright/test';

const adminStorageState = process.env.E2E_ADMIN_STORAGE_STATE;
const participantStorageState = process.env.E2E_PARTICIPANT_STORAGE_STATE;
const sessionStatesReady = Boolean(adminStorageState && participantStorageState);

if (process.env.E2E_REQUIRE_AUTH === '1' && !sessionStatesReady) {
  throw new Error(
    'Authenticated E2E is required, but E2E_ADMIN_STORAGE_STATE or E2E_PARTICIPANT_STORAGE_STATE is missing.',
  );
}

const viewportMatrix = [
  { width: 240, height: 320 },
  { width: 320, height: 240 },
  { width: 280, height: 653 },
  { width: 653, height: 280 },
  { width: 320, height: 568 },
  { width: 568, height: 320 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 800, height: 360 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 1366 },
  { width: 1023, height: 900 },
  { width: 1024, height: 900 },
  { width: 1119, height: 900 },
  { width: 1120, height: 900 },
  { width: 1199, height: 900 },
  { width: 1200, height: 900 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
] as const;

const screenshotViewports = new Set([
  '240x320',
  '320x240',
  '280x653',
  '653x280',
  '390x844',
  '844x390',
  '768x1024',
  '1024x1366',
  '1120x900',
  '1200x900',
  '1366x768',
  '1440x900',
  '1536x864',
  '1920x1080',
  '2560x1440',
  '3840x2160',
]);

async function assertAuthenticatedLanding(page: Page, expectedLanding: 'admin' | 'profile') {
  const browserDiagnostics: string[] = [];
  page.on('pageerror', (error) => browserDiagnostics.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      browserDiagnostics.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    browserDiagnostics.push(
      `requestfailed: ${url.origin}${url.pathname} (${request.failure()?.errorText ?? 'unknown'})`,
    );
  });
  const expectedPath = expectedLanding === 'admin' ? '/admin' : '/profile';
  try {
    await expect(async () => {
      const response = await page.goto(expectedPath, { waitUntil: 'domcontentloaded' });
      if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'NO_RESPONSE'}`);
      await expect(page).toHaveURL(
        expectedLanding === 'admin' ? /\/admin(?:\/|\?|$)/u : /\/profile(?:\?|$)/u,
        { timeout: 1_000 },
      );
    }).toPass({ timeout: 20_000 });
  } catch {
    throw new Error(
      `OTP browser session did not reach its protected workspace. ${browserDiagnostics.join(' | ')}`,
    );
  }
}

/**
 * `toEqual([])` reports only "expect(received).toEqual(expected)" on the line
 * the release CI summary keeps; the diff carrying the actual error text is on
 * the lines that summary discards (release-e2e-report.mjs deliberately never
 * uploads full page content — a page error can embed rendered DOM or seeded
 * account data). Failing with the message on line one instead makes a CI-only
 * failure diagnosable from that summary without a local repro.
 */
function assertNoPageErrors(pageErrors: readonly string[]) {
  if (pageErrors.length === 0) return;
  throw new Error(`page threw ${pageErrors.length} uncaught error(s): ${pageErrors.join(' | ')}`.slice(0, 400));
}

async function expectNoPageOverflow(page: Page, label: string) {
  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
        })),
      { message: `horizontal overflow at ${label}` },
    )
    .toEqual(
      expect.objectContaining({
        client: await page.evaluate(() => document.documentElement.clientWidth),
        scroll: await page.evaluate(() => document.documentElement.clientWidth),
      }),
    );
}

async function waitForEmployeesWorkspace(page: Page) {
  await expect(page.locator('[data-attestations-filter-form]')).toHaveAttribute(
    'data-client-ready',
    'true',
    { timeout: 20_000 },
  );
  await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
    'data-client-ready',
    'true',
    { timeout: 20_000 },
  );
}

async function captureViewport(
  page: Page,
  testInfo: TestInfo,
  name: string,
  viewport: { width: number; height: number },
) {
  const viewportKey = `${viewport.width}x${viewport.height}`;
  if (!screenshotViewports.has(viewportKey)) return;
  const filename = `${name}-${viewportKey}.png`;
  if (process.env.E2E_SCREENSHOT_REGRESSION === '1') {
    await expect(page).toHaveScreenshot(filename, {
      animations: 'disabled',
      caret: 'initial',
      fullPage: false,
      maxDiffPixelRatio: 0.015,
    });
    return;
  }
  await testInfo.attach(filename, {
    body: await page.screenshot({ animations: 'disabled', caret: 'initial', fullPage: false }),
    contentType: 'image/png',
  });
}

test.describe('authenticated operator and participant workspaces', () => {
  test.skip(
    !sessionStatesReady,
    'Run the release OTP-session setup and provide E2E_ADMIN_STORAGE_STATE and E2E_PARTICIPANT_STORAGE_STATE.',
  );

  test.describe('administrator workspace', () => {
    test.use({ storageState: adminStorageState });

    test('administrator completes the decisive employee workflow with keyboard-safe overlays', async ({
      page,
    }) => {
      test.setTimeout(60_000);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.setViewportSize({ width: 1280, height: 800 });
      await assertAuthenticatedLanding(page, 'admin');
      await expect(page.getByRole('heading', { name: 'В работе' })).toBeVisible();
      await page.goto('/profile');
      await expect(page).toHaveURL(/\/admin(?:\/|\?|$)/u);
      await expect(page.getByRole('link', { name: /Проверить данные/u })).toBeVisible();
      await expect(page.getByRole('link', { name: /Выдать сертификаты/u })).toBeVisible();

      await page.goto('/admin/employees');
      await expect(page.getByRole('heading', { name: 'Сотрудники' })).toBeVisible();
      await expect(page.getByLabel('Поиск по ФИО, компании или номеру сертификата')).toBeVisible();
      await waitForEmployeesWorkspace(page);
      assertNoPageErrors(pageErrors);

      const collapse = page.getByRole('button', { name: /^Свернуть компанию/u }).first();
      if (await collapse.isVisible()) {
        const company = (await collapse.getAttribute('aria-label'))?.replace(
          'Свернуть компанию ',
          '',
        );
        expect(company).toBeTruthy();
        await collapse.click();
        const expand = page.getByRole('button', {
          name: `Развернуть компанию ${company}`,
          exact: true,
        });
        await expect(expand).toHaveAttribute('aria-expanded', 'false');
        await expand.click();
      }

      const rowControl = page.getByRole('button', { name: /^Открыть сведения:/u }).first();
      await rowControl.click();
      const detail = page.getByRole('dialog');
      await expect(detail).toBeVisible();
      await expect(detail.getByText(/История сертификатов/u)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(detail).toBeHidden();
      await expect(rowControl).toBeFocused();

      const filters = page.getByRole('button', { name: /^Фильтры/u });
      await filters.click();
      await expect(page.getByRole('dialog', { name: 'Фильтры' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Фильтры' })).toBeHidden();
      await expect(filters).toBeFocused();

      const rowCheckbox = page.getByRole('checkbox', { name: /^Выбрать:/u }).first();
      await rowCheckbox.check();
      const bulkActions = page.getByRole('complementary', { name: 'Массовые действия' });
      await expect(bulkActions).toBeVisible();
      await bulkActions.getByRole('button', { name: /Снять выделение/u }).click();
    });

    test('operator controls survive phone landscape, 200% text, and forced colors', async ({
      page,
    }) => {
      await assertAuthenticatedLanding(page, 'admin');
      await page.setViewportSize({ width: 568, height: 320 });
      await page.goto('/admin/employees', { waitUntil: 'domcontentloaded' });
      await waitForEmployeesWorkspace(page);
      await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      await expectNoPageOverflow(page, 'admin at 200% text');

      const filters = page.getByRole('button', { name: /^Фильтры/u });
      await filters.click();
      const filterDialog = page.getByRole('dialog', { name: 'Фильтры' });
      await expect(filterDialog).toBeVisible();
      await expect(filterDialog).toHaveCSS('overflow-y', 'auto');
      await page.keyboard.press('Escape');
      await expect(filters).toBeFocused();

      await page.emulateMedia({ forcedColors: 'active' });
      await filters.focus();
      await expect(filters).toBeFocused();
      const target = await filters.boundingBox();
      expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
      expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
    });

    test('administrator workspace follows available container width across the full matrix', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await assertAuthenticatedLanding(page, 'admin');
      await page.goto('/admin/employees', { waitUntil: 'domcontentloaded' });
      await waitForEmployeesWorkspace(page);
      for (const viewport of viewportMatrix) {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', { name: 'Сотрудники' })).toBeVisible();
        await expectNoPageOverflow(page, `admin ${viewport.width}x${viewport.height}`);

        const tableHeader = page.getByRole('columnheader', { name: 'Сотрудник' });
        const contentWidth = await page
          .locator('.admin-workspace-container')
          .evaluate((element) => {
            const style = getComputedStyle(element);
            return (
              element.clientWidth -
              Number.parseFloat(style.paddingLeft) -
              Number.parseFloat(style.paddingRight)
            );
          });
        // The table appears as soon as the desktop sidebar does: at a 1024px
        // viewport the workspace container is exactly 760px wide, so a laptop no
        // longer falls back to the stacked mobile cards.
        const contentWideEnough = contentWidth >= 760;
        if (contentWideEnough) await expect(tableHeader).toBeVisible();
        else await expect(tableHeader).toBeHidden();

        const mobileNavigation = page.getByRole('navigation', {
          name: 'Мобильная навигация админ-панели',
        });
        // The admin sidebar takes over at 1024px, so the bottom dock disappears
        // there too. This still asserted the retired 1180px threshold.
        if (viewport.width >= 1024) await expect(mobileNavigation).toBeHidden();
        else await expect(mobileNavigation).toBeVisible();

        await captureViewport(page, testInfo, 'admin-employees', viewport);
      }
    });
  });

  test.describe('participant workspace', () => {
    test.use({ storageState: participantStorageState });

    test('participant sees the next action without technical attempt state across the matrix', async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await assertAuthenticatedLanding(page, 'profile');
      await page.goto('/profile', { waitUntil: 'domcontentloaded' });
      const learningDashboard = page.locator('[data-learning-dashboard]');
      for (const viewport of viewportMatrix) {
        await page.setViewportSize(viewport);
        const viewportLabel = `${viewport.width}x${viewport.height}`;
        await expect(
          learningDashboard,
          `participant learning dashboard must be ready at ${viewportLabel}`,
        ).toHaveAttribute('data-state', 'ready');
        await expect(
          learningDashboard.getByText('Следующий шаг', { exact: true }),
          `participant next action must be visible at ${viewportLabel}`,
        ).toBeVisible();
        await expect(
          learningDashboard.getByText(/Сдано \d+ из \d+ · Сертификатов \d+/u),
          `participant course summary must be visible at ${viewportLabel}`,
        ).toBeVisible();
        await expect(
          learningDashboard.getByText(/attempt|попыток|revision|UUID/iu),
          `participant learning dashboard must hide technical attempt state at ${viewportLabel}`,
        ).toHaveCount(0);
        await expect(
          page.locator('#my-data'),
          `participant profile editor must be visible at ${viewportLabel}`,
        ).toBeVisible();
        await expectNoPageOverflow(page, `participant ${viewport.width}x${viewport.height}`);
        await captureViewport(page, testInfo, 'participant-profile', viewport);
      }
    });
  });

  test.describe('administrator editors', () => {
    test.use({ storageState: adminStorageState });

    test('course and article editors keep a compact action bar at phone and desktop widths', async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await assertAuthenticatedLanding(page, 'admin');

      const editorUrls: Array<{ list: string; linkName: RegExp; snapshot: string }> = [
        { list: '/admin/courses', linkName: /^Редактировать:/u, snapshot: 'admin-course-editor' },
        { list: '/admin/articles', linkName: /^Редактировать:/u, snapshot: 'admin-article-editor' },
      ];

      for (const editor of editorUrls) {
        const pageErrorOffset = pageErrors.length;
        await page.goto(editor.list, { waitUntil: 'domcontentloaded' });
        const href = await page
          .getByRole('link', { name: editor.linkName })
          .first()
          .getAttribute('href');
        expect(href).toBeTruthy();
        await page.goto(href!, { waitUntil: 'domcontentloaded' });
        await expect(page.locator('[data-editor-shell]')).toBeVisible();

        if (editor.snapshot === 'admin-course-editor') {
          // The saved question bank has to actually arrive: an empty first
          // question means the editor is back to inventing 30 blank ones and a
          // save would wipe the stored bank.
          const firstQuestion = page.locator('#variant-0-question-0');
          await expect(firstQuestion).toBeVisible();
          await expect(firstQuestion).not.toHaveValue('');
          const firstAnswer = page.getByRole('radio', { name: /^Ответ 1 правильный$/u });
          await expect(firstAnswer).toBeVisible();
        }

        for (const viewport of [
          { width: 390, height: 844 },
          { width: 1440, height: 900 },
        ]) {
          await page.setViewportSize(viewport);
          const actionBar = page.locator('[data-editor-action-bar]');
          await expect(actionBar).toBeVisible();
          const box = await actionBar.boundingBox();
          expect(box).toBeTruthy();
          expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(64);
          await expectNoPageOverflow(page, `${editor.snapshot} ${viewport.width}px`);
          await captureViewport(page, testInfo, editor.snapshot, viewport);
        }
        const editorPageErrors = pageErrors.slice(pageErrorOffset);
        if (editorPageErrors.length > 0) {
          throw new Error(
            `E2E_PAGE_ERROR:${editor.snapshot}:${editorPageErrors.slice(0, 3).join(' | ')}`,
          );
        }
      }
      assertNoPageErrors(pageErrors);
    });
  });
});
