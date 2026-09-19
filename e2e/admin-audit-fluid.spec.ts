import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

// The exhaustive width sweep is an explicit acceptance run, not a skipped CI smoke test.
if (process.env.E2E_ADMIN_AUDIT_SWEEP === '1') {
  if (!process.env.E2E_ADMIN_STORAGE_STATE) throw new Error('Admin storage state required');
  test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, video: 'off' });
  test.describe.configure({ mode: 'parallel' });
  const heights = (process.env.E2E_AUDIT_SWEEP_HEIGHTS ?? process.env.E2E_UX_HEIGHTS ?? '240,800')
    .split(',')
    .map(Number);
  const lower = Number(process.env.E2E_UX_MIN_WIDTH ?? 240);
  const upper = Number(process.env.E2E_UX_MAX_WIDTH ?? 3840);
  const widths = [...Array.from({ length: upper - lower + 1 }, (_, i) => lower + i), 5120, 7680];
  const captures = new Set([
    240, 265, 280, 295, 310, 375, 399, 400, 401, 640, 768, 1024, 1280, 1440, 2560, 3840,
  ]);

  async function inspect(page: Page, state: string) {
    return page.evaluate((state) => {
      const failures: string[] = [];
      const surface =
        state === 'details'
          ? document.querySelector<HTMLElement>('dialog[open]')
          : state === 'menu'
            ? document.querySelector<HTMLElement>('[role="menu"]')
            : document.querySelector<HTMLElement>('[data-audit-workspace]');
      if (!surface) return ['Missing active surface'];
      const describe = (node: Element) =>
        `${node.tagName}:${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 60)}`;
      if (document.documentElement.scrollWidth > innerWidth + 1)
        failures.push(`page overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
      if (surface.scrollWidth > surface.clientWidth + 1)
        failures.push(`surface overflow ${surface.scrollWidth}/${surface.clientWidth}`);
      const roots =
        state === 'page'
          ? [
              surface,
              ...document.querySelectorAll<HTMLElement>(
                'nav[aria-label="Мобильная навигация админ-панели"]',
              ),
            ]
          : [surface];
      for (const root of roots) {
        const controls = [
          ...root.querySelectorAll<HTMLElement>('button,a,input,summary,[role="menuitem"]'),
        ].filter((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
          );
        });
        for (const node of controls) {
          const rect = node.getBoundingClientRect();
          if (rect.left < -1 || rect.right > innerWidth + 1)
            failures.push(`action outside viewport ${describe(node)} ${rect.left}:${rect.right}`);
          if (
            ['BUTTON', 'SUMMARY'].includes(node.tagName) &&
            node.scrollHeight > node.clientHeight + 2
          )
            failures.push(`clipped action ${describe(node)}`);
        }
        const visible = controls.filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.bottom > 0 && rect.top < innerHeight;
        });
        for (let i = 0; i < visible.length; i++) {
          const a = visible[i]!;
          const ra = a.getBoundingClientRect();
          for (const b of visible.slice(i + 1)) {
            if (a.contains(b) || b.contains(a)) continue;
            const rb = b.getBoundingClientRect();
            if (
              Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 3 &&
              Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 3
            )
              failures.push(`overlapping actions ${describe(a)} / ${describe(b)}`);
          }
        }
      }
      return failures.slice(0, 10);
    }, state);
  }

  for (const state of ['page', 'details', 'menu']) {
    test(`audit and navigation fluid acceptance: ${state}`, async ({ page }, testInfo) => {
      test.setTimeout(3_600_000);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto('/admin/settings/history', { waitUntil: 'networkidle', timeout: 120_000 });
      await expect(
        page.getByRole('heading', { name: 'История действий', exact: true }),
      ).toBeVisible();
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
        style.textContent =
          '*,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; }';
        document.head.append(style);
      });
      if (state === 'details') {
        await page.getByRole('button', { name: 'Подробности', exact: true }).first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('dialog').getByText('Технические сведения', { exact: true }).click();
      }
      if (state === 'menu') {
        await page
          .locator('header')
          .getByRole('button', { name: /^Меню пользователя/ })
          .click();
        await expect(page.getByRole('menuitem', { name: 'Настройки сайта' })).toBeVisible();
      }
      let checked = 0;
      for (const height of heights) {
        for (const width of widths) {
          await page.setViewportSize({ width, height });
          // Radix positions the open avatar menu after the resize observer runs.
          if (state === 'menu')
            await page.evaluate(
              () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
            );
          const failures = await inspect(page, state);
          if (failures.length)
            await page.screenshot({
              path: testInfo.outputPath(`${state}-${width}x${height}-failure.png`),
            });
          if (failures.length) expect(failures, `${state} at ${width}x${height}`).toEqual([]);
          checked++;
          if (captures.has(width) && height === heights.at(-1))
            await page.screenshot({
              path: testInfo.outputPath(`${state}-${width}x${height}.png`),
              fullPage: state === 'page',
            });
        }
        await writeFile(
          testInfo.outputPath('sweep-progress.json'),
          JSON.stringify(
            {
              state,
              lower,
              upper,
              step: 1,
              extraWidths: [5120, 7680],
              heights,
              completedHeight: height,
              checked,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          ),
        );
      }
      await testInfo.attach('sweep-summary', {
        body: JSON.stringify({
          state,
          lower,
          upper,
          step: 1,
          extraWidths: [5120, 7680],
          heights,
          checked,
        }),
        contentType: 'application/json',
      });
    });
  }

  test('audit touch orientations and enlarged text keep actions usable', async ({
    browser,
  }, testInfo) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({
      storageState: process.env.E2E_ADMIN_STORAGE_STATE,
      baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100',
      hasTouch: true,
      ignoreHTTPSErrors:
        new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100').hostname ===
        'localhost',
      locale: 'ru-RU',
    });
    const page = await context.newPage();
    try {
      await page.goto('/admin/audit', { waitUntil: 'networkidle', timeout: 120_000 });
      for (const height of [240, 465, 475, 479, 480, 481, 485, 495]) {
        await page.setViewportSize({ width: 1440, height });
        const links = page
          .getByRole('navigation', { name: 'Навигация админ-панели', exact: true })
          .getByRole('link');
        for (const link of await links.all()) {
          await link.scrollIntoViewIfNeeded();
          const sidebarGeometry = await page.evaluate(() => {
            const aside = document.querySelector<HTMLElement>('[data-admin-shell] > aside')!;
            const nav = aside.querySelector('nav')!;
            const a = getComputedStyle(aside),
              n = getComputedStyle(nav);
            return {
              viewport: [innerWidth, innerHeight],
              short: matchMedia('(max-height:30rem)').matches,
              aside: {
                height: a.height,
                position: a.position,
                alignSelf: a.alignSelf,
                rect: aside.getBoundingClientRect().toJSON(),
              },
              nav: {
                height: n.height,
                overflow: n.overflow,
                flex: n.flex,
                rect: nav.getBoundingClientRect().toJSON(),
              },
            };
          });
          await expect(
            link,
            `sidebar link at height ${height}: ${JSON.stringify(sidebarGeometry)}`,
          ).toBeInViewport({ ratio: 1 });
        }
      }
      for (const viewport of [
        { width: 240, height: 800 },
        { width: 800, height: 240 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        expect(await inspect(page, 'page'), `${viewport.width}x${viewport.height} touch`).toEqual(
          [],
        );
        await page.getByRole('button', { name: 'Подробности', exact: true }).first().tap();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByRole('button', { name: 'Закрыть детали', exact: true }).tap();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await page.screenshot({
          path: testInfo.outputPath(`audit-touch-${viewport.width}x${viewport.height}.png`),
        });
      }
      // Browser text enlargement is distinct from the continuous effective-width sweep.
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.evaluate(() => {
        const style = document.createElement('style');
        style.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
        style.textContent = 'html { font-size: 200% !important; }';
        document.head.append(style);
      });
      await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      expect(await inspect(page, 'page'), '200% text').toEqual([]);
      await page.getByRole('button', { name: 'Подробности', exact: true }).first().tap();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await inspect(page, 'details'), '200% text details').toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('audit-text-200-percent.png') });
      await page.getByRole('button', { name: 'Закрыть детали', exact: true }).tap();
      await page.setViewportSize({ width: 240, height: 240 });
      const skipLink = page.getByRole('link', { name: 'К содержанию', exact: true });
      await skipLink.focus();
      await expect(skipLink).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Enter');
      await expect(page.locator('#admin-main')).toBeFocused();
      const chrome = await page.evaluate(() => ({
        header: getComputedStyle(document.querySelector('[data-admin-mobile-header]')!).position,
        nav: getComputedStyle(document.querySelector('[data-admin-mobile-nav]')!).position,
      }));
      expect(chrome).toEqual({ header: 'static', nav: 'static' });
    } finally {
      await context.close();
    }
  });

  test('audit filters, detail focus and direct navigation preserve context', async ({ page }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 240, height: 800 });
    await page.goto('/admin/settings/history', { waitUntil: 'networkidle', timeout: 120_000 });
    const details = page.getByRole('button', { name: 'Подробности', exact: true }).first();
    await details.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(details).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Закрыть детали', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(details).toBeFocused();
    await page.getByRole('link', { name: '7 дней', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/settings\/history\?.*tz=local/);
    await expect(page.locator('#audit-from')).not.toHaveValue('');
    await page.locator('#audit-actor').fill('Нет такого сотрудника ЖҰҰ 中文 very-long-name');
    await page.getByRole('button', { name: 'Показать', exact: true }).click();
    await expect(page.getByText('События по выбранным фильтрам не найдены.')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/settings\/history\?/);
    await page.getByRole('link', { name: 'Сбросить', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/settings\/history$/);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#audit-actor')).toHaveValue('');
    await page
      .locator('header')
      .getByRole('button', { name: /^Меню пользователя/ })
      .click();
    const settingsItem = page.getByRole('menuitem', { name: 'Настройки сайта', exact: true });
    await expect(settingsItem).toHaveAttribute('href', '/admin/settings');
    await settingsItem.click();
    await expect(page).toHaveURL(/\/admin\/settings$/, { timeout: 120_000 });
    await expect(page.locator('main').getByRole('link', { name: 'Мой аккаунт' })).toHaveCount(0);
    await page
      .getByRole('navigation', { name: 'Мобильная навигация админ-панели', exact: true })
      .getByRole('link', { name: 'Материалы', exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin\/articles$/, { timeout: 120_000 });
  });
}
