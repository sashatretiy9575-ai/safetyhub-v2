import { expect, test } from '@playwright/test';

// Explicit opt-in keeps the release suite free of thousands of expensive checks.
if (process.env.E2E_ADMIN_DOCUMENT_SWEEP === '1') {
  test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, video: 'off' });
  test.describe.configure({ mode: 'parallel' });
  const course = process.env.E2E_ADMIN_SWEEP_COURSE ?? 'biot';
  for (const [name, path] of [
    ['list', '/admin/documents'],
    ['common', '/admin/documents/common'],
    ['course-protocol', `/admin/documents/${course}`],
    ['course-booklet', `/admin/documents/${course}?preview=booklet`],
  ] as const) {
    test(`documents ${name} fluid widths`, async ({ page }, info) => {
      test.setTimeout(240 * 60_000);
      page.setDefaultTimeout(20_000);
      const max = Number(process.env.E2E_ADMIN_SWEEP_MAX ?? 3840);
      const step = Number(process.env.E2E_ADMIN_SWEEP_STEP ?? 8);
      const heights = (process.env.E2E_ADMIN_SWEEP_HEIGHTS ?? '320,640,900')
        .split(',')
        .map(Number);
      const failures: string[] = [];
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      if (name !== 'list') {
        await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible({
          timeout: 120_000,
        });
      }
      for (const height of heights) {
        for (let width = 240; width <= max; width += width < 1440 ? step : step * 8) {
          await page.setViewportSize({ width, height });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          if (overflow > 0) failures.push(`${width}x${height}: ${overflow}px wider than the screen`);
        }
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: info.outputPath(`${name}-390.png`), fullPage: true });
      expect(failures).toEqual([]);
    });
  }
}
