import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Explicit opt-in keeps the release suite free of thousands of expensive checks.
if (process.env.E2E_ADMIN_DOCUMENT_SWEEP === '1') {
  test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, video: 'off' });
  test.describe.configure({ mode: 'parallel' });
  for (const kind of ['certificate', 'protocol'] as const)
    for (const mode of ['fields', 'expanded', 'preview'] as const) {
      test(`document editor ${kind}/${mode} fluid widths`, async ({ page }, info) => {
        test.setTimeout(240 * 60_000);
        page.setDefaultTimeout(20_000);
        page.on('dialog', (dialog) => dialog.accept());
        page.on('console', (msg) => {
          if (msg.type() === 'error') console.log('browser', msg.text().slice(0, 300));
        });
        page.on('response', (response) => {
          if (response.status() >= 400)
            console.log('HTTP_DIAGNOSTIC', response.status(), new URL(response.url()).pathname);
        });
        const max = Number(process.env.E2E_ADMIN_SWEEP_MAX ?? 3840);
        const artifactStem = `${kind}-${mode}${info.project.name === 'chromium' ? '' : `-${info.project.name.replace(/[^a-z0-9_-]/gi, '_')}`}`;
        const heights = (process.env.E2E_ADMIN_SWEEP_HEIGHTS ?? '240,320,480,640,800,900,1080,1440')
          .split(',')
          .map(Number);
        await page.goto('/admin/settings/certificate', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('.document-editor').filter({ visible: true })).toHaveCount(1);
        await expect(page.locator('.document-editor').filter({ visible: true })).toHaveAttribute(
          'data-hydrated',
          '',
          {
            timeout: 120_000,
          },
        );
        const dataResponse = await page.request.get('/api/admin/documents');
        expect(dataResponse.ok()).toBeTruthy();
        const data = await dataResponse.json();
        let chosen: {
          organization: string;
          course: string;
          user: string;
          certificateId: string;
          participants: number;
        } | null = null;
        for (const organization of data.organizations) {
          for (const course of data.courses) {
            const response = await page.request.get('/api/admin/documents', {
              params: { organization, course: course.slug },
            });
            expect(
              response.ok(),
              `Document fixture request returned ${response.status()}`,
            ).toBeTruthy();
            const company = await response.json();
            const participant = company.participants?.find(
              (person: { certificateId: string | null }) => person.certificateId,
            );
            if (participant) {
              chosen = {
                organization,
                course: course.slug,
                user: participant.userId,
                certificateId: participant.certificateId,
                participants: company.participants.length,
              };
              break;
            }
          }
          if (chosen) break;
        }
        expect(chosen, 'A matching company/course must contain an issued document').not.toBeNull();
        expect(chosen!.participants).toBeGreaterThan(0);
        const query = new URLSearchParams({
          organization: chosen!.organization,
          course: chosen!.course,
          user: chosen!.user,
          tab: 'certificate',
        });
        const url = new URL('/admin/settings/certificate?' + query, page.url()).href;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const editor = page.locator('.document-editor').filter({ visible: true });
        await expect(editor).toHaveCount(1);
        await expect(editor).toHaveAttribute('data-hydrated', '', { timeout: 120_000 });
        await page.setViewportSize({ width: 240, height: 640 });
        if (kind === 'certificate' && mode === 'fields') {
          await editor
            .getByRole('textbox', { name: 'Номер', exact: true })
            .fill('Проверка-未保存-Ұзын-Long');
          await editor.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
          await editor.getByRole('radio', { name: 'Изменить', exact: true }).click();
          await expect(editor.getByRole('textbox', { name: 'Номер', exact: true })).toHaveValue(
            'Проверка-未保存-Ұзын-Long',
          );
          await page.setViewportSize({ width: 640, height: 240 });
          await expect(editor.getByRole('textbox', { name: 'Номер', exact: true })).toHaveValue(
            'Проверка-未保存-Ұзын-Long',
          );
          await page.screenshot({ path: info.outputPath('editor-landscape-640x240.png') });
        }

        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.setViewportSize({ width: 240, height: 640 });
        await page.evaluate(() => {
          const style = document.createElement('style');
          style.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
          style.textContent =
            '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
          document.head.append(style);
        });
        await expect(editor).toHaveAttribute('data-hydrated', '', { timeout: 120_000 });
        await page.evaluate(async () => {
          await document.fonts.ready;
        });
        await editor
          .getByRole('radio', {
            name: kind === 'certificate' ? 'Удостоверение' : 'Протокол',
            exact: true,
          })
          .click();
        if (mode === 'expanded') {
          while (await editor.locator('section > button[aria-expanded="false"]').count())
            await editor.locator('section > button[aria-expanded="false"]').first().click();
          for (const details of await editor.locator('details').all())
            await details.evaluate((e) => {
              (e as HTMLDetailsElement).open = true;
            });
        }
        if (mode === 'preview')
          await editor.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
        if (mode === 'preview') {
          const canvas = editor.locator('canvas').filter({ visible: true }).first();
          await expect(
            canvas,
            'Preview must render the actual document, not an empty state',
          ).toBeVisible({ timeout: 30_000 });
          expect(
            await canvas.evaluate(
              (node) =>
                (node as HTMLCanvasElement).width > 0 && (node as HTMLCanvasElement).height > 0,
            ),
          ).toBeTruthy();
        }
        const widthOverride = process.env.E2E_UX_WIDTHS;
        const widths = widthOverride
          ? [...new Set(widthOverride.split(',').map(Number))]
          : Array.from({ length: max - 239 }, (_, i) => 240 + i);
        if (widthOverride) {
          expect(widths.length).toBeGreaterThan(0);
          for (const width of widths) {
            expect(
              Number.isInteger(width) && width >= 240 && width <= 7680,
              `Invalid E2E_UX_WIDTHS viewport: ${width}`,
            ).toBeTruthy();
          }
        } else if (max >= 3840) widths.push(5120, 7680);
        const failures: unknown[] = [];
        let checks = 0;
        await mkdir('test-results/admin-document-fluid', { recursive: true });
        for (const height of heights) {
          for (const width of widths) {
            await page.setViewportSize({ width, height });
            const result = await page.evaluate(async () => {
              await new Promise<void>((r) => requestAnimationFrame(() => r()));
              const root = document.documentElement;
              const visibleEditors = [
                ...document.querySelectorAll<HTMLElement>('.document-editor'),
              ].filter((element) => {
                const box = element.getBoundingClientRect();
                return (
                  box.width > 0 &&
                  box.height > 0 &&
                  getComputedStyle(element).visibility !== 'hidden'
                );
              });
              if (visibleEditors.length !== 1)
                throw new Error(
                  `Expected one visible editor during measurement, found ${visibleEditors.length}`,
                );
              const actions = [
                ...visibleEditors[0]!.querySelectorAll<HTMLElement>('button,input,textarea,select'),
              ].filter(
                (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden',
              );
              const rectangles = new Map(
                actions.map((element) => [element, element.getBoundingClientRect()]),
              );
              const clipped = actions
                .filter((e) => {
                  const r = rectangles.get(e)!;
                  return (
                    r.left < -1 ||
                    r.right > root.clientWidth + 1 ||
                    (e.scrollWidth > e.clientWidth + 2 &&
                      !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName))
                  );
                })
                .map((e) => e.getAttribute('aria-label') || e.textContent?.trim());
              const buttons = actions.filter((e) => e.tagName === 'BUTTON');
              const overlapDetails: unknown[] = [];
              const overlaps = buttons
                .filter((a, i) =>
                  buttons.slice(i + 1).some((b) => {
                    if (a.contains(b) || b.contains(a)) return false;
                    const x = rectangles.get(a)!,
                      y = rectangles.get(b)!;
                    const intersects =
                      Math.min(x.right, y.right) - Math.max(x.left, y.left) > 2 &&
                      Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 2;
                    if (intersects)
                      overlapDetails.push({
                        a: a.getAttribute('aria-label') || a.textContent?.trim(),
                        b: b.getAttribute('aria-label') || b.textContent?.trim(),
                        aRect: x.toJSON(),
                        bRect: y.toJSON(),
                        viewportHeight: innerHeight,
                        visibleIntersection:
                          Math.min(x.bottom, y.bottom, innerHeight) - Math.max(x.top, y.top, 0) > 2,
                      });
                    return intersects;
                  }),
                )
                .map((e) => e.getAttribute('aria-label') || e.textContent?.trim());
              return {
                overflow: root.scrollWidth > root.clientWidth + 1,
                clipped,
                overlaps,
                overlapDetails,
              };
            });
            checks++;
            if (
              mode === 'expanded' &&
              ((width === 640 && height === 240) || (width === 1024 && height === 900))
            ) {
              await page.screenshot({
                path: info.outputPath(`${kind}-expanded-${width}x${height}.png`),
                fullPage: false,
              });
            }
            if (
              (result.overflow || result.clipped.length || result.overlaps.length) &&
              failures.length < 100
            ) {
              failures.push({ width, height, ...result });
              await writeFile(
                `test-results/admin-document-fluid/${artifactStem}-progress.json`,
                JSON.stringify({
                  kind,
                  mode,
                  checks,
                  heights,
                  width,
                  height,
                  fixture: chosen,
                  failures,
                }),
              );
              expect(failures, `${kind}/${mode} at ${width}x${height}`).toEqual([]);
            }
          }
          await writeFile(
            `test-results/admin-document-fluid/${artifactStem}-progress.json`,
            JSON.stringify({
              kind,
              mode,
              checks,
              heights,
              completedHeight: height,
              fixture: chosen,
              failures,
            }),
          );
        }
        const report = {
          checks,
          heights,
          coverage: widthOverride ? 'selected widths' : 'continuous integer widths',
          widths: widthOverride ? widths : undefined,
          min: Math.min(...widths),
          max: Math.max(...widths),
          continuousThrough: widthOverride ? undefined : max,
          failures,
        };
        await mkdir('test-results/admin-document-fluid', { recursive: true });
        await writeFile(
          `test-results/admin-document-fluid/${artifactStem}.json`,
          JSON.stringify(
            {
              strategy:
                'Actual main browser viewport with rAF at every tested width; draft/preview/rotation interaction in certificate/fields.',
              kind,
              mode,
              fixture: chosen,
              ...report,
            },
            null,
            2,
          ),
        );
        expect(report.failures, `${kind}/${mode}`).toEqual([]);
        await page.setViewportSize({ width: 240, height: 640 });
        await page.screenshot({ path: info.outputPath(`${kind}-${mode}-240x640.png`) });
        if (mode === 'preview')
          await editor.getByRole('radio', { name: 'Изменить', exact: true }).click();
      });
    }
  test.describe('mocked document request', () => {
    test.use({ serviceWorkers: 'block' });
    test('editor loading and failed participant request keep actions reachable', async ({
      page,
    }, info) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(20_000);
      await page.setViewportSize({ width: 240, height: 480 });
      await page.goto('/admin/settings/certificate');
      const editor = page.locator('.document-editor').filter({ visible: true });
      await expect(editor).toHaveCount(1);
      await expect(editor).toHaveAttribute('data-hydrated', '');
      const data = await (await page.request.get('/api/admin/documents')).json();
      expect(data.organizations.length).toBeGreaterThan(0);
      let release!: () => void;
      let requested!: () => void;
      const pending = new Promise<void>((r) => {
        requested = r;
      });
      const responseGate = new Promise<void>((r) => {
        release = r;
      });
      await page.route('**/api/admin/documents?*', async (route) => {
        requested();
        await responseGate;
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"error":"TEST_FAILURE"}',
        });
      });
      await editor.getByRole('button', { name: /^Компания/ }).click();
      await editor.getByRole('button', { name: data.organizations[0], exact: true }).click();
      await pending;
      await expect(
        editor.getByRole('button', { name: 'Сохранить настройки', exact: true }).last(),
      ).toBeDisabled();
      await page.screenshot({ path: info.outputPath('editor-loading-240x480.png') });
      release();
      await expect(
        editor.getByText('Участники не загрузились, выберите компанию ещё раз').last(),
      ).toBeVisible();
      for (const width of [
        240, 265, 280, 295, 310, 399, 400, 401, 639, 640, 641, 1023, 1024, 1025, 2560, 3840,
      ]) {
        await page.setViewportSize({ width, height: 480 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          ),
        ).toBeTruthy();
      }
      await page.setViewportSize({ width: 240, height: 480 });
      await page.screenshot({ path: info.outputPath('editor-failure-240x480.png') });
    });
  });
}
