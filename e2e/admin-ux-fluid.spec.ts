import { writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function addPermittedStyle(page: Page, content: string) {
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
    style.textContent = css;
    document.head.append(style);
  }, content);
}

// Explicit opt-in: this exhaustive acceptance run is separate from the release smoke suite.
if (process.env.E2E_ADMIN_UX_SWEEP === '1') {
  test.describe.configure({ mode: 'parallel' });
  if (!process.env.E2E_ADMIN_STORAGE_STATE) throw new Error('Admin storage state required');
  test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, video: 'off' });

  const heights = (process.env.E2E_UX_HEIGHTS ?? '240,800').split(',').map(Number);
  const lower = Number(process.env.E2E_UX_MIN_WIDTH ?? 240);
  const upper = Number(process.env.E2E_UX_MAX_WIDTH ?? 3840);
  const widths = [...Array.from({ length: upper - lower + 1 }, (_, i) => lower + i), 5120, 7680];
  const screenshots = new Set([240, 265, 295, 375, 640, 768, 1024, 1440, 2560, 3840]);

  async function inspect(page: Page) {
    return page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const failures: string[] = [];
      const describe = (node: Element) =>
        `${node.tagName}:${node.getAttribute('aria-label') ?? node.textContent?.trim().slice(0, 70)}`;
      const root =
        [...document.querySelectorAll('dialog[open],[role="dialog"]')].reverse().find((node) => {
          const rect = node.getBoundingClientRect();
          return (
            rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== 'hidden'
          );
        }) ??
        document.querySelector('main') ??
        document.body;
      if (document.documentElement.scrollWidth > innerWidth + 1) {
        failures.push(`page overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
        for (const node of [...document.querySelectorAll('body *')]
          .filter((node) => !node.closest('dialog'))
          .filter((node) => {
            const r = node.getBoundingClientRect();
            return r.width > 0 && r.right > innerWidth + 1;
          })
          .slice(0, 4))
          failures.push(
            `background overflow ${describe(node)} ${node.getBoundingClientRect().right} ${node.className}`,
          );
      }
      if (root.scrollWidth > root.clientWidth + 1)
        failures.push(`surface overflow ${root.scrollWidth}/${root.clientWidth}`);
      const controls = [
        ...root.querySelectorAll<HTMLElement>('button,a,input,select,textarea,summary'),
      ].filter((node) => {
        const r = node.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          !node.closest('[inert],[aria-hidden="true"]') &&
          getComputedStyle(node).visibility !== 'hidden'
        );
      });
      for (const node of controls) {
        const r = node.getBoundingClientRect();
        if (r.left < -1 || r.right > innerWidth + 1)
          failures.push(`action outside viewport ${describe(node)} ${r.left}:${r.right}`);
        if (
          ['BUTTON', 'SUMMARY'].includes(node.tagName) &&
          node.scrollHeight > node.clientHeight + 2
        )
          failures.push(`action text clipped ${describe(node)}`);
      }
      const visibleRect = (node: HTMLElement) => {
        const box = node.getBoundingClientRect();
        let left = Math.max(0, box.left),
          right = Math.min(innerWidth, box.right);
        let top = Math.max(0, box.top),
          bottom = Math.min(innerHeight, box.bottom);
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
          const css = getComputedStyle(parent),
            rect = parent.getBoundingClientRect();
          if (/auto|scroll|hidden|clip/.test(css.overflowX)) {
            left = Math.max(left, rect.left);
            right = Math.min(right, rect.right);
          }
          if (/auto|scroll|hidden|clip/.test(css.overflowY)) {
            top = Math.max(top, rect.top);
            bottom = Math.min(bottom, rect.bottom);
          }
        }
        return { left, right, top, bottom, width: right - left, height: bottom - top };
      };
      const visibleRects = new Map(controls.map((node) => [node, visibleRect(node)] as const));
      const visible = controls.filter((node) => {
        const rect = visibleRects.get(node)!;
        return rect.width > 0 && rect.height > 0;
      });
      for (let i = 0; i < visible.length; i++) {
        const a = visible[i]!;
        const ra = visibleRects.get(a)!;
        for (const b of visible.slice(i + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const rb = visibleRects.get(b)!;
          if (
            Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left) > 3 &&
            Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > 3
          )
            failures.push(`actions overlap ${describe(a)} / ${describe(b)}`);
        }
      }
      return failures.slice(0, 8);
    });
  }

  for (const state of [
    'list',
    'selection',
    'selection-many',
    'bulk-delete',
    'bulk-update',
    'card',
    'edit',
    'danger',
  ] as const) {
    test(`employee fluid acceptance: ${state}`, async ({ page }, testInfo) => {
      test.setTimeout(3_600_000);
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.goto('/admin/employees', { timeout: 120_000 });
      await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
        'data-client-ready',
        'true',
      );
      if (['selection', 'selection-many', 'bulk-delete', 'bulk-update'].includes(state)) {
        await page
          .getByRole('checkbox', { name: /^Выбрать:/u })
          .first()
          .check();
        await expect(
          page.getByRole('complementary', { name: 'Выбранные сотрудники' }),
        ).toBeVisible();
        if (state !== 'selection')
          for (let i = 1; i < 7; i++)
            await page
              .getByRole('checkbox', { name: /^Выбрать:/u })
              .nth(i)
              .check();
        if (state === 'bulk-delete')
          await page
            .getByRole('complementary', { name: 'Выбранные сотрудники' })
            .getByRole('button', { name: /Удалить сотрудников/ })
            .click();
        if (state === 'bulk-update')
          await page
            .getByRole('complementary', { name: 'Выбранные сотрудники' })
            .getByRole('button', { name: 'Переименовать компанию', exact: true })
            .click();
      } else if (state !== 'list') {
        await page
          .getByRole('button', { name: /^Открыть сведения:/u })
          .first()
          .click();
        await expect(page.getByRole('dialog')).toBeVisible();
        if (state === 'edit') {
          await page.getByRole('button', { name: 'Изменить данные', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Сохранить данные' })).toBeVisible();
          await expect(page.getByRole('dialog').getByRole('textbox').first()).toBeEnabled();
        }
        if (state === 'danger')
          await page.getByRole('button', { name: 'Удалить учебную историю', exact: true }).click();
      }
      if (['card', 'edit', 'danger'].includes(state))
        await expect
          .poll(async () => (await page.getByRole('dialog').innerText()).includes('Загружаем'), {
            timeout: 60000,
          })
          .toBe(false);
      await addPermittedStyle(
        page,
        '*,*::before,*::after { animation:none!important; transition:none!important; scroll-behavior:auto!important; }',
      );
      let checked = 0;
      for (const height of heights) {
        for (const width of widths) {
          await page.setViewportSize({ width, height });
          const failures = await inspect(page);
          if (failures.length) expect(failures, `${state} at ${width}x${height}`).toEqual([]);
          checked++;
          if (screenshots.has(width) && height === heights.at(-1)) {
            await page.screenshot({
              path: testInfo.outputPath(`${state}-${width}x${height}.png`),
              fullPage: false,
            });
            if (['card', 'edit', 'danger'].includes(state)) {
              const body = page.locator('[data-attestation-detail-body]');
              const previousTop = await body.evaluate((node) => {
                const top = node.scrollTop;
                node.scrollTop = node.scrollHeight;
                return top;
              });
              await page.screenshot({
                path: testInfo.outputPath(`${state}-bottom-${width}x${height}.png`),
                fullPage: false,
              });
              await body.evaluate((node, top) => {
                node.scrollTop = top;
              }, previousTop);
            }
          }
        }
        await writeFile(
          testInfo.outputPath('sweep-progress.json'),
          JSON.stringify({
            state,
            widths: `${lower}–${upper} step1 +5120/7680`,
            heights,
            completedThroughHeight: height,
            checked,
            passed: true,
          }),
        );
      }
      await testInfo.attach('sweep-summary', {
        body: JSON.stringify({
          state,
          widths: `${lower}–${upper} step 1 + 5120,7680`,
          heights,
          checked,
        }),
        contentType: 'application/json',
      });
    });
  }
  test('opening another employee and cancelling deletion preserves seven selected people', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto('/admin/employees', { timeout: 120_000 });
    await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
      'data-client-ready',
      'true',
    );
    const checkboxes = page.getByRole('checkbox', { name: /^Выбрать:/u });
    const openButtons = page.getByRole('button', { name: /^Открыть сведения:/u });
    const uniquePeople = await openButtons.evaluateAll((buttons) => {
      const names = new Set<string>();
      return buttons.flatMap((button, index) => {
        const name = button.getAttribute('aria-label') ?? button.textContent ?? '';
        if (names.has(name)) return [];
        names.add(name);
        return [index];
      });
    });
    expect(uniquePeople.length).toBeGreaterThanOrEqual(8);
    for (let i = 0; i < 7; i++) {
      await checkboxes.nth(uniquePeople[i]!).check();
      await expect(checkboxes.nth(uniquePeople[i]!)).toBeChecked();
      await expect(page.getByRole('complementary', { name: 'Выбранные сотрудники' })).toContainText(
        `Выбрано: ${i + 1}`,
      );
    }
    await expect(
      page.getByRole('button', { name: 'Удалить сотрудников (7)', exact: true }),
    ).toBeVisible();
    await openButtons.nth(uniquePeople[7]!).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Удалить сотрудника', exact: true })
      .click();
    const confirmation = page.getByRole('dialog', { name: 'Удалить сотрудников', exact: true });
    await expect(confirmation.getByText(/Будет удалено человек: 1\./)).toBeVisible();
    await confirmation.getByRole('button', { name: 'Отмена', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Выбранные сотрудники' })).toContainText(
      'Выбрано: 7',
    );
    for (let i = 0; i < 7; i++) await expect(checkboxes.nth(uniquePeople[i]!)).toBeChecked();
    await expect(checkboxes.nth(uniquePeople[7]!)).not.toBeChecked();
  });
  test('employee draft survives touch rotation and enlarged text', async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({
      storageState: process.env.E2E_ADMIN_STORAGE_STATE,
      hasTouch: true,
      ignoreHTTPSErrors:
        new URL(process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100').hostname ===
        'localhost',
    });
    const page = await context.newPage();
    try {
      await page.goto(
        `${process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100'}/admin/employees`,
        { timeout: 120_000 },
      );
      await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
        'data-client-ready',
        'true',
      );
      await page
        .getByRole('button', { name: /^Открыть сведения:/u })
        .first()
        .tap();
      await page.getByRole('button', { name: 'Изменить данные', exact: true }).tap();
      const name = page.getByRole('dialog').getByLabel('Имя', { exact: true });
      await name.fill('Несохранённое-Ұзын-Long-未保存');
      for (const viewport of [
        { width: 240, height: 800 },
        { width: 800, height: 240 },
        { width: 768, height: 1024 },
        { width: 1024, height: 768 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(name).toHaveValue('Несохранённое-Ұзын-Long-未保存');
        expect(await inspect(page), `touch ${viewport.width}x${viewport.height}`).toEqual([]);
      }
      await addPermittedStyle(page, 'html { font-size: 200% !important; }');
      await expect(page.locator('html')).toHaveCSS('font-size', '32px');
      for (const viewport of [
        { width: 240, height: 800 },
        { width: 1440, height: 900 },
      ]) {
        await page.setViewportSize(viewport);
        expect(await inspect(page), `text200 ${viewport.width}`).toEqual([]);
      }
      await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).tap();
      await expect(page.getByRole('dialog')).toBeHidden();
    } finally {
      await context.close();
    }
  });
  test('an open card survives a reload and leaves with the list it belongs to', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const manager = page.locator('[data-attestations-manager]');
    // History entry one is a filtered list; removing the filter makes entry two.
    await page.goto('/admin/employees?q=%D0%B0', { timeout: 120_000 });
    await page.getByRole('link', { name: /Убрать фильтр/u }).click();
    await expect(page).not.toHaveURL(/[?&]q=/u);
    await expect(manager).toHaveAttribute('data-client-ready', 'true');

    const trigger = page.getByRole('button', { name: /^Открыть сведения:/u }).nth(1);
    const recordId = await trigger.getAttribute('data-card-trigger');
    expect(recordId).toMatch(/^[0-9a-f-]{36}$/u);
    const fullName = ((await trigger.getAttribute('aria-label')) ?? '').replace(
      'Открыть сведения: ',
      '',
    );
    const withCard = new RegExp(`[?&]card=${recordId}(?:&|$)`, 'u');
    await trigger.click();
    const card = page.getByRole('dialog', { name: fullName, exact: true });
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(withCard);

    await page.reload();
    await expect(manager).toHaveAttribute('data-client-ready', 'true');
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(withCard);
    // Closing takes the parameter away and hands the keyboard back to the row,
    // exactly as if the card had been opened with its button.
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]card=/u);
    await expect(page.locator(`[data-card-trigger="${recordId}"]`)).toBeFocused();

    // The card belongs to the list under it: back on the filtered list there is
    // no card and no parameter, because no filter link ever carries it.
    await trigger.click();
    await expect(card).toBeVisible();
    await expect(page).toHaveURL(withCard);
    await page.goBack();
    await expect(page).toHaveURL(/[?&]q=/u);
    await expect(page).not.toHaveURL(/[?&]card=/u);
    await expect(page.getByRole('dialog')).toBeHidden();

    // Only an identifier of a row on this page opens anything.
    for (const value of ['not-a-uuid', '00000000-0000-4000-8000-000000000000']) {
      await page.goto(`/admin/employees?card=${value}`, { timeout: 120_000 });
      await expect(manager).toHaveAttribute('data-client-ready', 'true');
      await expect(page).not.toHaveURL(/[?&]card=/u);
      await expect(page.getByRole('dialog')).toBeHidden();
    }
  });
  test('the first tick and the last one keep the ticked row where it is', async ({ page }) => {
    test.setTimeout(120_000);
    const panel = page.getByRole('complementary', { name: 'Выбранные сотрудники' });
    const checks = page.getByRole('checkbox', { name: /^Выбрать:/u });
    const top = (index: number) =>
      checks.nth(index).evaluate((node) => node.getBoundingClientRect().top);
    for (const viewport of [
      { width: 1440, height: 800 },
      { width: 375, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto('/admin/employees', { timeout: 120_000 });
      // The visible one: on a repeated load React can leave the segment's streamed
      // HTML behind in its `hidden` container, which an unfiltered locator also sees.
      await expect(
        page.locator('[data-attestations-manager]').filter({ visible: true }),
      ).toHaveAttribute('data-client-ready', 'true');
      // Row 1 is ticked at the very top of the page, where the browser's scroll
      // anchoring does not apply; a row below the fold is ticked after scrolling,
      // where it does. The panel that appears above the list must move neither.
      const far = Math.min((await checks.count()) - 1, 20);
      expect(far).toBeGreaterThan(1);
      for (const index of [1, far]) {
        const label = `row ${index} at ${viewport.width}px`;
        // A trial run does Playwright's own scrolling first, so the two
        // measurements differ only by what the page did.
        await checks.nth(index).check({ trial: true });
        const before = await top(index);
        await checks.nth(index).check();
        await expect(panel).toBeVisible();
        expect(Math.abs((await top(index)) - before), `first tick, ${label}`).toBeLessThanOrEqual(
          2,
        );
        await checks.nth(index).uncheck({ trial: true });
        const ticked = await top(index);
        await checks.nth(index).uncheck();
        await expect(panel).toBeHidden();
        expect(Math.abs((await top(index)) - ticked), `last untick, ${label}`).toBeLessThanOrEqual(
          2,
        );
      }
    }
  });
  test.describe('mocked avatar response', () => {
    test.use({ serviceWorkers: 'block' });
    /**
     * The seeded people have no photos, so the list is told that everyone has
     * one; the photo route itself is mocked by each test. `avatarAvailable`
     * travels in the page's own payload (escaped inside the HTML, plain in a
     * refresh), which is why the document is rewritten instead of an API.
     */
    async function pretendEveryoneHasPhoto(page: Page) {
      await page.route(/\/admin\/employees(?:\?[^#]*)?$/u, async (route) => {
        const response = await route.fetch();
        const body = (await response.text()).replace(/(\\?"avatarAvailable\\?":)false/gu, '$1true');
        await route.fulfill({ response, body });
      });
    }
    test('a photo that does not arrive leaves the initials and stops pulsing', async ({ page }) => {
      test.setTimeout(120_000);
      let photoRequests = 0;
      await page.route('**/api/admin/attestations/avatar/*', async (route) => {
        photoRequests++;
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'NOT_FOUND' }),
        });
      });
      await pretendEveryoneHasPhoto(page);
      try {
        await page.goto('/admin/employees', { timeout: 120_000 });
        await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
          'data-client-ready',
          'true',
        );
        await page
          .getByRole('button', { name: /^Открыть сведения:/u })
          .first()
          .click();
        const dialog = page.getByRole('dialog');
        const avatar = dialog.locator('[data-profile-avatar]');
        // Without this the test would pass on a card that never asked for a photo.
        await expect.poll(() => photoRequests).toBeGreaterThan(0);
        await expect(avatar.locator('img')).toHaveCount(0);
        await expect(avatar).not.toHaveClass(/animate-pulse/u);
        await expect(avatar).toHaveText(/^.{1,2}$/u);
        // No link to a photo that is not there.
        await expect(dialog.locator('a[title="Открыть фото"]')).toHaveCount(0);
        for (const width of [240, 1440]) {
          await page.setViewportSize({ width, height: 800 });
          expect(await inspect(page), `missing photo ${width}x800`).toEqual([]);
        }
      } finally {
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
    test('a slow photo holds back neither the contacts nor the course list', async ({ page }) => {
      test.setTimeout(120_000);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let photoRequested = false;
      await page.route('**/api/admin/attestations/avatar/*', async (route) => {
        photoRequested = true;
        await gate;
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'NOT_FOUND' }),
        });
      });
      await page.route('**/api/admin/attestations/contact/*', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: 'slow.photo@example.test', phoneE164: '+77011234567' }),
        }),
      );
      await pretendEveryoneHasPhoto(page);
      try {
        await page.goto('/admin/employees', { timeout: 120_000 });
        await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
          'data-client-ready',
          'true',
        );
        await page
          .getByRole('button', { name: /^Открыть сведения:/u })
          .first()
          .click();
        const dialog = page.getByRole('dialog');
        const avatar = dialog.locator('[data-profile-avatar]');
        await expect.poll(() => photoRequested).toBe(true);
        // Everything the card is opened for is there while the photo is still
        // on its way: the initials stand in its box, which pulses.
        await expect(
          dialog.getByRole('link', { name: 'Позвонить: +7 701 123 4567' }),
        ).toBeVisible();
        await expect(
          dialog.getByRole('link', { name: 'slow.photo@example.test', exact: true }),
        ).toBeVisible();
        await expect(dialog.getByRole('checkbox').first()).toBeVisible();
        await expect(avatar).toHaveClass(/animate-pulse/u);
        await expect(avatar).toHaveText(/^.{1,2}$/u);
        const box = await avatar.boundingBox();
        release();
        await expect(avatar).not.toHaveClass(/animate-pulse/u);
        // The box had its final size from the first paint.
        expect(await avatar.boundingBox()).toEqual(box);
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  });
  test.describe('mocked contacts response', () => {
    test.use({ serviceWorkers: 'block' });
    const longAddress = `${'long.contact.'.repeat(8)}example@example.test`;
    // Stored, but not the canonical form a `tel:` or WhatsApp link needs.
    const undialablePhone = '8 (701) 123-45-67';
    for (const transient of [
      'loading',
      'failed',
      'empty',
      'invalid-phone',
      'long-data',
      'identity-failed',
    ] as const) {
      test(`employee transient boundary acceptance: ${transient}`, async ({ page }, testInfo) => {
        test.setTimeout(120_000);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let intercepted = false;
        // Flipped right before «Повторить»: counting requests instead would
        // break under a development server, where effects run twice.
        let contactsRecovered = false;
        await page.route(
          transient === 'identity-failed'
            ? '**/api/admin/users/*/identity*'
            : '**/api/admin/attestations/contact/*',
          async (route) => {
            intercepted = true;
            if (transient === 'loading') await gate;
            const failed =
              transient === 'identity-failed' || (transient === 'failed' && !contactsRecovered);
            await route.fulfill({
              status: failed ? 500 : 200,
              contentType: 'application/json',
              body: JSON.stringify(
                transient === 'empty'
                  ? { email: null, phoneE164: null }
                  : {
                      // The two transients that watch the answer arrive use an
                      // address of ordinary length: one line, like the
                      // placeholder that held its place.
                      email:
                        transient === 'loading' || transient === 'failed'
                          ? 'contact@example.test'
                          : longAddress,
                      phoneE164: transient === 'invalid-phone' ? undialablePhone : '+77011234567',
                    },
              ),
            });
          },
        );
        try {
          await page.goto('/admin/employees', { timeout: 120_000 });
          await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
            'data-client-ready',
            'true',
          );
          await page
            .getByRole('button', { name: /^Открыть сведения:/u })
            .first()
            .click();
          const dialog = page.getByRole('dialog');
          const contacts = dialog.getByRole('group', { name: 'Связаться', exact: true });
          const contactLinks = dialog.locator('a[href^="tel:"], a[href*="wa.me"]');
          const boundaryWidths = [
            240, 265, 385, 395, 399, 400, 401, 405, 415, 625, 635, 639, 640, 641, 645, 655, 768,
            1009, 1019, 1023, 1024, 1025, 1029, 1039, 3840,
          ];
          let checked = 0;
          const sweep = async (label: string) => {
            for (const height of [240, 800])
              for (const width of boundaryWidths) {
                await page.setViewportSize({ width, height });
                expect(await inspect(page), `${label} ${width}x${height}`).toEqual([]);
                checked++;
              }
          };
          if (transient === 'identity-failed')
            await dialog.getByRole('button', { name: 'Изменить данные', exact: true }).click();
          await expect.poll(() => intercepted).toBe(true);
          if (transient === 'loading') {
            // Placeholders of the final size and nothing to press yet.
            await expect(contacts).toBeVisible();
            await expect(contactLinks).toHaveCount(0);
          }
          if (transient === 'failed')
            await expect(dialog.getByText('Контакты не загрузились.')).toBeVisible();
          if (transient === 'empty') {
            await expect(contacts.getByText('Телефон не указан', { exact: true })).toBeVisible();
            await expect(contactLinks).toHaveCount(0);
            await expect(dialog.locator('a[href^="mailto:"]')).toHaveCount(0);
          }
          if (transient === 'invalid-phone') {
            // Shown as typed, with no link that would dial a number nobody has.
            await expect(contacts.getByText(undialablePhone, { exact: true })).toBeVisible();
            await expect(contactLinks).toHaveCount(0);
          }
          if (transient === 'identity-failed')
            await expect(dialog.getByRole('alert')).toContainText(
              'Не удалось загрузить образование',
            );
          if (transient === 'long-data') {
            // The address is the one text link; the mail button is gone for good.
            const address = dialog.getByRole('link', { name: longAddress, exact: true });
            await expect(address).toBeVisible();
            await expect(address).toHaveAttribute('href', `mailto:${longAddress}`);
            await expect(dialog.locator('a[href^="mailto:"]')).toHaveCount(1);
            await expect(dialog.getByText('Написать на почту')).toHaveCount(0);
            await expect(
              contacts.getByRole('link', { name: 'Написать в WhatsApp: +7 701 123 4567' }),
            ).toHaveAttribute('href', 'https://wa.me/77011234567');
            await expect(
              contacts.getByRole('link', { name: 'Позвонить: +7 701 123 4567' }),
            ).toHaveAttribute('href', 'tel:+77011234567');
            // Printed once: the two links carry it in their names, not as text.
            await expect(dialog.getByText('+7 701 123 4567', { exact: true })).toHaveCount(1);
            // The long address is swept while it is on screen, then the form is.
            await sweep(`${transient} view`);
            await dialog.getByRole('button', { name: 'Изменить данные', exact: true }).click();
            await dialog
              .getByLabel('Имя', { exact: true })
              .fill('ДлинноеИмяҰзынАтыLongName姓名'.repeat(2));
            await dialog
              .getByLabel('Компания', { exact: true })
              .fill('КомпанияҰйымCompany企业'.repeat(6));
          }
          await sweep(transient);
          if (transient === 'loading' || transient === 'failed') {
            // The contacts row and the address line above it hold their place
            // in every state, so the answer moves nothing under them.
            await page.setViewportSize({ width: 1440, height: 800 });
            const before = await contacts.boundingBox();
            expect(before).not.toBeNull();
            if (transient === 'loading') release();
            else {
              contactsRecovered = true;
              await contacts.getByRole('button', { name: 'Повторить', exact: true }).click();
            }
            await expect(
              contacts.getByRole('link', { name: 'Позвонить: +7 701 123 4567' }),
            ).toBeVisible();
            await expect(
              dialog.getByRole('link', { name: 'contact@example.test', exact: true }),
            ).toBeVisible();
            const after = await contacts.boundingBox();
            expect(Math.abs(after!.height - before!.height)).toBeLessThanOrEqual(1);
            expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(1);
          }
          await testInfo.attach('boundary-summary', {
            body: JSON.stringify({
              transient,
              boundaryWidths,
              heights: [240, 800],
              checked,
            }),
            contentType: 'application/json',
          });
        } finally {
          release();
          await page.unrouteAll({ behavior: 'wait' });
        }
      });
    }
  });
  test.describe('mocked identity response', () => {
    test.use({ serviceWorkers: 'block' });
    test('whole learning history deletion clears both selected courses and keeps another employee', async ({
      page,
    }) => {
      let deletions = 0;
      await page.route('**/api/admin/users/*/learning-history', async (route) => {
        if (route.request().method() !== 'DELETE') return route.continue();
        deletions++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            deleted: true,
            counts: {
              attempts: 2,
              startedAttempts: 0,
              attestations: 2,
              activeCertificates: 1,
              revokedCertificates: 0,
            },
          }),
        });
      });
      await page.goto('/admin/employees');
      await expect(
        page.locator('[data-attestations-manager]').filter({ visible: true }),
      ).toHaveAttribute('data-client-ready', 'true');
      const open = page.getByRole('button', { name: /^Открыть сведения:/u });
      const names = await open.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-label')),
      );
      const repeated = names.find((name) => names.filter((other) => other === name).length >= 2);
      expect(repeated).toBeTruthy();
      const samePerson = names
        .flatMap((name, index) => (name === repeated ? [index] : []))
        .slice(0, 2);
      const otherPerson = names.findIndex((name) => name !== repeated);
      expect(otherPerson).toBeGreaterThanOrEqual(0);
      const checks = page.getByRole('checkbox', { name: /^Выбрать:/u });
      for (const index of [...samePerson, otherPerson]) {
        await checks.nth(index).check();
        await expect(checks.nth(index)).toBeChecked();
      }
      const selection = page.getByRole('complementary', { name: 'Выбранные сотрудники' });
      await expect(selection).toContainText('Выбрано: 3');
      await open.nth(samePerson[0]!).click();
      const card = page.getByRole('dialog');
      await card.getByRole('button', { name: 'Удалить учебную историю', exact: true }).click();
      await card
        .getByLabel('Причина, минимум 10 символов', { exact: true })
        .fill('Проверка удаления всей истории');
      await card.getByLabel('Введите УДАЛИТЬ', { exact: true }).fill('УДАЛИТЬ');
      await card.getByRole('button', { name: 'Удалить без восстановления', exact: true }).click();
      await expect(card).toBeHidden();
      await expect(selection).toContainText('Выбрано: 1');
      for (const index of samePerson) await expect(checks.nth(index)).not.toBeChecked();
      await expect(checks.nth(otherPerson)).toBeChecked();
      expect(deletions).toBe(1);
    });
    test('single issuance refreshes the same resolved selection and retries without losing people', async ({
      page,
    }) => {
      let original: { recordIds: string[]; total: number; [key: string]: unknown } | undefined;
      const refreshedIds: string[][] = [];
      await page.route('**/api/admin/attestations/selection', async (route) => {
        const body = route.request().postDataJSON();
        if (!body.recordIds) {
          const response = await route.fetch();
          original = await response.json();
          await route.fulfill({ response });
          return;
        }
        refreshedIds.push(body.recordIds);
        await route.fulfill({
          status: refreshedIds.length === 1 ? 500 : 200,
          contentType: 'application/json',
          body: JSON.stringify(
            refreshedIds.length === 1
              ? { error: 'INTERNAL_ERROR' }
              : {
                  ...original,
                  pendingIdentity: 0,
                  ready: 0,
                  issued: original!.total,
                  exportable: original!.total,
                },
          ),
        });
      });
      await page.route('**/api/admin/attestations/actions', async (route) => {
        const body = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: body.attestationIds.map((id: string) => ({
              id,
              status: 'completed',
              reason: null,
            })),
          }),
        });
      });
      await page.goto('/admin/employees');
      await expect(
        page.locator('[data-attestations-manager]').filter({ visible: true }),
      ).toHaveAttribute('data-client-ready', 'true');
      await page
        .getByRole('checkbox', { name: /^Выбрать:/u })
        .first()
        .check();
      await page.getByRole('button', { name: /^Выбрать все \d+ по фильтру$/u }).click();
      await expect.poll(() => original?.recordIds.length ?? 0).toBeGreaterThan(1);
      const selected = page.getByRole('complementary', { name: 'Выбранные сотрудники' });
      await expect(selected).toContainText(`Выбрано: ${original!.total}`);
      await page
        .getByRole('row')
        .filter({ has: page.getByText('Ожидает проверки', { exact: true }) })
        .first()
        .getByRole('button', { name: /^Открыть сведения:/u })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Подтвердить и выдать', exact: true })
        .click();
      await expect(selected.getByRole('button', { name: 'Обновить сводку выбора' })).toBeVisible();
      for (const width of [240, 265]) {
        await page.setViewportSize({ width, height: 480 });
        expect(await inspect(page), `selection refresh error ${width}x480`).toEqual([]);
      }
      await expect(selected).toContainText(`Выбрано: ${original!.total}`);
      await expect(
        selected.getByRole('button', { name: 'Подтвердить и выдать', exact: true }),
      ).toBeDisabled();
      await selected.getByRole('button', { name: 'Обновить сводку выбора' }).click();
      await expect(selected.getByRole('button', { name: 'Обновить сводку выбора' })).toBeHidden();
      // The refreshed summary has everyone issued: the export is what is left
      // to do, and «Подтвердить и выдать» has nobody to confirm and nothing to
      // issue, so it stays disabled instead of opening a dialog that skips all.
      await expect(
        selected.getByRole('button', { name: 'Скачать пакет документов', exact: true }),
      ).toBeEnabled();
      await expect(
        selected.getByRole('button', { name: 'Подтвердить и выдать', exact: true }),
      ).toBeDisabled();
      await expect(selected.getByRole('status').first()).toHaveText(
        `Выбрано: ${original!.total} · с сертификатом ${original!.total}`,
      );
      expect(refreshedIds).toEqual([original!.recordIds, original!.recordIds]);
      await expect(selected).toContainText(`Выбрано: ${original!.total}`);
      await selected.getByRole('button', { name: 'Скачать пакет документов', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(
        new RegExp(`Сертификатов(?: в ZIP)?: ${original!.total} из ${original!.total}`),
      );
      await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    });
    test('the card always asks for education and a refused save keeps what was typed', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const interceptedMethods: string[] = [];
      await page.route('**/api/admin/users/*/identity*', (route) => {
        interceptedMethods.push(route.request().method());
        return route.fulfill({
          status: route.request().method() === 'GET' ? 200 : 409,
          contentType: 'application/json',
          body: JSON.stringify(
            route.request().method() === 'GET'
              ? { education: '' }
              : { error: 'DOCUMENT_REQUIRED_FIELDS', fields: ['education'] },
          ),
        });
      });
      await page.goto('/admin/employees', { timeout: 120_000 });
      await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
        'data-client-ready',
        'true',
      );
      await page
        .getByRole('button', { name: /^Открыть сведения:/u })
        .first()
        .click();
      await page.getByRole('button', { name: 'Изменить данные', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Имя', { exact: true }).fill('СохранитьРедактирование');
      await expect.poll(() => interceptedMethods.includes('GET')).toBe(true);
      await expect(dialog.getByRole('button', { name: 'Сохранить данные' })).toBeEnabled();
      // Education is asked of everyone, so the field is on the card from the
      // start; a refusal only sends the cursor back to it.
      await expect(dialog.getByLabel('Образование', { exact: true })).toBeVisible();
      await dialog.getByLabel('Образование', { exact: true }).selectOption('Высшее');
      await dialog.getByRole('button', { name: 'Сохранить данные' }).click();
      await expect.poll(() => interceptedMethods.includes('PATCH')).toBe(true);
      await expect(dialog.getByLabel('Образование', { exact: true })).toBeFocused();
      await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue(
        'СохранитьРедактирование',
      );
      // The draft outlives the card: closed by accident and opened again, the
      // form is back with what was typed. «Отмена» is what drops it.
      const open = page.getByRole('button', { name: /^Открыть сведения:/u }).first();
      const edit = dialog.getByRole('button', { name: 'Изменить данные', exact: true });
      await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await expect(dialog).toBeHidden();
      await open.click();
      await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue(
        'СохранитьРедактирование',
      );
      await expect(edit).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      await expect(edit).toBeFocused();
      await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
      await expect(dialog).toBeHidden();
      await open.click();
      await expect(edit).toBeVisible();
      await expect(dialog.getByLabel('Имя', { exact: true })).toHaveCount(0);
    });
    test('a save from a stale card is refused and the card returns to the current data', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      const saves: Array<Record<string, unknown>> = [];
      await page.route('**/api/admin/users/*/identity*', (route) => {
        if (route.request().method() === 'GET')
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ education: 'Высшее техническое', version: 3 }),
          });
        saves.push(route.request().postDataJSON());
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'IDENTITY_CHANGED' }),
        });
      });
      await page.goto('/admin/employees', { timeout: 120_000 });
      await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
        'data-client-ready',
        'true',
      );
      await page
        .getByRole('button', { name: /^Открыть сведения:/u })
        .first()
        .click();
      const dialog = page.getByRole('dialog');
      const edit = dialog.getByRole('button', { name: 'Изменить данные', exact: true });
      await edit.click();
      await dialog.getByLabel('Имя', { exact: true }).fill('ПравкаПоверхЧужой');
      await expect(dialog.getByRole('button', { name: 'Сохранить данные' })).toBeEnabled();
      await dialog.getByRole('button', { name: 'Сохранить данные' }).click();
      await expect(dialog.getByRole('alert')).toContainText(
        'Данные сотрудника не сохранены: их уже изменил другой администратор.',
      );
      // The save named the version the form was opened on.
      expect(saves).toHaveLength(1);
      expect(saves[0]).toMatchObject({ action: 'verify', expectedVersion: 3 });
      for (const width of [240, 1440]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await inspect(page), `identity conflict ${width}x800`).toEqual([]);
      }
      await dialog.getByRole('button', { name: 'Показать актуальные', exact: true }).click();
      // Back to reading, with the keyboard on the way in and no draft kept.
      await expect(edit).toBeFocused();
      await edit.click();
      await expect(dialog.getByLabel('Имя', { exact: true })).not.toHaveValue('ПравкаПоверхЧужой');
    });
    test('an issuance refused for the person’s own data opens the card on those fields', async ({
      page,
    }) => {
      test.setTimeout(120_000);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const keys: string[] = [];
      await page.route('**/api/admin/attestations/actions', async (route) => {
        const body = route.request().postDataJSON();
        keys.push(body.idempotencyKey);
        await gate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            items: (body.attestationIds ?? body.userIds).map((id: string) => ({
              id,
              status: 'skipped',
              reason: 'DOCUMENT_REQUIRED_FIELDS:organization,position',
            })),
          }),
        });
      });
      try {
        await page.goto('/admin/employees', { timeout: 120_000 });
        await expect(page.locator('[data-attestations-manager]')).toHaveAttribute(
          'data-client-ready',
          'true',
        );
        await page
          .getByRole('row')
          .filter({ has: page.getByText('Ожидает проверки', { exact: true }) })
          .first()
          .getByRole('button', { name: /^Открыть сведения:/u })
          .click();
        const dialog = page.getByRole('dialog');
        const action = dialog.getByRole('button', { name: 'Подтвердить и выдать', exact: true });
        // Both halves of a double click land before the button is disabled;
        // only one request may leave, and the card waits for its answer.
        await action.dblclick();
        await expect(action).toBeDisabled();
        await expect(dialog).toBeVisible();
        release();
        await expect(dialog.getByRole('alert')).toHaveText(
          'Сертификат не выдан: заполните организацию и должность сотрудника.',
        );
        expect(keys).toHaveLength(1);
        const company = dialog.getByLabel('Компания', { exact: true });
        await expect(company).toBeFocused();
        await expect(company).toHaveAttribute('aria-invalid', 'true');
        await expect(dialog.getByLabel('Должность', { exact: true })).toHaveAttribute(
          'aria-invalid',
          'true',
        );
        await expect(dialog.getByLabel('Имя', { exact: true })).not.toHaveAttribute(
          'aria-invalid',
          'true',
        );
        for (const width of [240, 1440]) {
          await page.setViewportSize({ width, height: 800 });
          expect(await inspect(page), `refused issuance ${width}x800`).toEqual([]);
        }
        // Typing answers the refusal: the message and the marks go.
        await company.fill('ТОО Исправленная компания');
        await expect(dialog.getByRole('alert')).toHaveCount(0);
        await expect(company).not.toHaveAttribute('aria-invalid', 'true');
      } finally {
        release();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  });
}
