import { expect, test, type Page, type TestInfo } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL;
const participantEmail = process.env.E2E_PARTICIPANT_EMAIL;
const password = process.env.E2E_PASSWORD ?? process.env.SAFETYHUB_SEED_PASSWORD;
const credentialsReady = Boolean(adminEmail && participantEmail && password);

if (process.env.E2E_REQUIRE_AUTH === '1' && !credentialsReady) {
  throw new Error(
    'Authenticated E2E is required, but E2E_ADMIN_EMAIL, E2E_PARTICIPANT_EMAIL or E2E_PASSWORD is missing.',
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

async function login(page: Page, email: string, expectedLanding: 'admin' | 'profile') {
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
  await page.goto('/auth/login', { waitUntil: 'domcontentloaded' });
  const emailInput = page.getByRole('textbox', { name: 'Email', exact: true });
  const passwordInput = page.getByRole('textbox', { name: 'Пароль', exact: true });
  const passwordVisibility = page.getByRole('button', { name: 'Показать пароль', exact: true });
  const hidePassword = page.getByRole('button', { name: 'Скрыть пароль', exact: true });
  try {
    await expect(async () => {
      await passwordVisibility.click();
      await expect(hidePassword).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
  } catch {
    throw new Error(
      `Login client hydration did not become interactive. ${browserDiagnostics.join(' | ')}`,
    );
  }
  await hidePassword.click();
  await emailInput.fill(email);
  await passwordInput.fill(password!);
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password!);

  // The Playwright web server receives the public test key even when the test
  // runner itself does not. Detect the rendered widget instead of consulting
  // the runner environment, otherwise the submit races the test challenge.
  const securityCheck = page.getByRole('group', {
    name: 'Проверка безопасности Cloudflare',
  });
  if ((await securityCheck.count()) > 0) {
    await securityCheck.focus();
    await expect(page.getByText('Проверка пройдена', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
  }

  const [loginResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/login') && response.request().method() === 'POST',
      { timeout: 20_000 },
    ),
    page.getByRole('button', { name: 'Войти', exact: true }).click(),
  ]);
  if (!loginResponse.ok()) {
    const payload = (await loginResponse.json().catch(() => null)) as { error?: unknown } | null;
    const errorCode = typeof payload?.error === 'string' ? payload.error : 'UNKNOWN_ERROR';
    throw new Error(`Login API failed with HTTP ${loginResponse.status()}: ${errorCode}`);
  }
  await expect(page).toHaveURL(
    expectedLanding === 'admin' ? /\/admin(?:\/|\?|$)/u : /\/profile(?:\?|$)/u,
    { timeout: 20_000 },
  );
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
  test.skip(!credentialsReady, 'Run npm run seed:workspace and provide E2E_* credentials.');

  test('administrator completes the decisive employee workflow with keyboard-safe overlays', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, adminEmail!, 'admin');
    await expect(page.getByRole('heading', { name: 'В работе' })).toBeVisible();
    await page.goto('/profile');
    await expect(page).toHaveURL(/\/admin(?:\/|\?|$)/u);
    await expect(page.getByRole('link', { name: /Проверить данные/u })).toBeVisible();
    await expect(page.getByRole('link', { name: /Выдать сертификаты/u })).toBeVisible();

    await page.goto('/admin/employees');
    await expect(page.getByRole('heading', { name: 'Сотрудники' })).toBeVisible();
    await expect(page.getByLabel('Поиск по ФИО, компании или номеру сертификата')).toBeVisible();
    await waitForEmployeesWorkspace(page);
    expect(pageErrors).toEqual([]);

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
    await login(page, adminEmail!, 'admin');
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
    await login(page, adminEmail!, 'admin');
    await page.goto('/admin/employees', { waitUntil: 'domcontentloaded' });
    await waitForEmployeesWorkspace(page);
    for (const viewport of viewportMatrix) {
      await page.setViewportSize(viewport);
      await expect(page.getByRole('heading', { name: 'Сотрудники' })).toBeVisible();
      await expectNoPageOverflow(page, `admin ${viewport.width}x${viewport.height}`);

      const tableHeader = page.getByRole('columnheader', { name: 'Сотрудник' });
      const contentWidth = await page.locator('.admin-workspace-container').evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight)
        );
      });
      const contentWideEnough = contentWidth >= 960;
      if (contentWideEnough) await expect(tableHeader).toBeVisible();
      else await expect(tableHeader).toBeHidden();

      const mobileNavigation = page.getByRole('navigation', {
        name: 'Мобильная навигация админ-панели',
      });
      if (viewport.width >= 1180) await expect(mobileNavigation).toBeHidden();
      else await expect(mobileNavigation).toBeVisible();

      await captureViewport(page, testInfo, 'admin-employees', viewport);
    }
  });

  test('participant sees the next action without technical attempt state across the matrix', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await login(page, participantEmail!, 'profile');
    await page.goto('/profile', { waitUntil: 'domcontentloaded' });
    for (const viewport of viewportMatrix) {
      await page.setViewportSize(viewport);
      await expect(page.getByText('Следующий шаг', { exact: true })).toBeVisible();
      await expect(page.getByText(/Сдано \d+ из \d+ · Сертификатов \d+/u)).toBeVisible();
      await expect(page.getByText(/attempt|попыток|revision|UUID/iu)).toHaveCount(0);
      await expect(page.getByText('Мои данные')).toBeVisible();
      await expectNoPageOverflow(page, `participant ${viewport.width}x${viewport.height}`);
      await captureViewport(page, testInfo, 'participant-profile', viewport);
    }
  });

  test('course and article editors keep a compact action bar at phone and desktop widths', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await login(page, adminEmail!, 'admin');

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
    expect(pageErrors).toEqual([]);
  });
});
