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
  test.describe('mocked contacts response', () => {
    test.use({ serviceWorkers: 'block' });
    for (const transient of [
      'loading',
      'failed',
      'empty',
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
        await page.route(
          transient === 'identity-failed'
            ? '**/api/admin/users/*/identity*'
            : '**/api/admin/attestations/contact/*',
          async (route) => {
            intercepted = true;
            if (transient === 'loading') await gate;
            await route.fulfill({
              status: transient === 'failed' || transient === 'identity-failed' ? 500 : 200,
              contentType: 'application/json',
              body: JSON.stringify(
                transient === 'empty'
                  ? { email: null, phoneE164: null }
                  : {
                      email: `${'long.contact.'.repeat(8)}example@example.test`,
                      phoneE164: '+77011234567',
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
          if (transient === 'identity-failed' || transient === 'long-data')
            await dialog.getByRole('button', { name: 'Изменить данные', exact: true }).click();
          await expect.poll(() => intercepted).toBe(true);
          if (transient === 'failed')
            await expect(dialog.getByText('Контакты не загрузились.')).toBeVisible();
          if (transient === 'identity-failed')
            await expect(dialog.getByRole('alert')).toContainText(
              'Не удалось загрузить образование',
            );
          if (transient === 'long-data') {
            await dialog
              .getByLabel('Имя', { exact: true })
              .fill('ДлинноеИмяҰзынАтыLongName姓名'.repeat(2));
            await dialog
              .getByLabel('Компания', { exact: true })
              .fill('КомпанияҰйымCompany企业'.repeat(6));
            await expect(
              dialog.getByRole('link', { name: 'Написать на почту', exact: true }),
            ).toBeVisible();
          }
          const boundaryWidths = [
            240, 265, 385, 395, 399, 400, 401, 405, 415, 625, 635, 639, 640, 641, 645, 655, 768,
            1009, 1019, 1023, 1024, 1025, 1029, 1039, 3840,
          ];
          for (const height of [240, 800])
            for (const width of boundaryWidths) {
              await page.setViewportSize({ width, height });
              expect(await inspect(page), `${transient} ${width}x${height}`).toEqual([]);
            }
          await testInfo.attach('boundary-summary', {
            body: JSON.stringify({
              transient,
              boundaryWidths,
              heights: [240, 800],
              checked: boundaryWidths.length * 2,
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
      await expect(
        selected.getByRole('button', { name: 'Подтвердить и выдать', exact: true }),
      ).toBeEnabled();
      await expect(
        selected.getByRole('button', { name: 'Скачать пакет документов', exact: true }),
      ).toBeEnabled();
      expect(refreshedIds).toEqual([original!.recordIds, original!.recordIds]);
      await expect(selected).toContainText(`Выбрано: ${original!.total}`);
      await selected.getByRole('button', { name: 'Скачать пакет документов', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(
        new RegExp(`Сертификатов(?: в ZIP)?: ${original!.total} из ${original!.total}`),
      );
      await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    });
    test('server education requirement reveals a previously hidden field without losing edits', async ({
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
              ? { education: '', educationRequired: false }
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
      await expect(dialog.getByLabel('Образование', { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Сохранить данные' }).click();
      await expect(dialog.getByLabel('Образование', { exact: true })).toBeVisible();
      await expect(dialog.getByLabel('Образование', { exact: true })).toBeFocused();
      await expect(dialog.getByLabel('Имя', { exact: true })).toHaveValue(
        'СохранитьРедактирование',
      );
    });
  });
}
