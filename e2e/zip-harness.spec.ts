import { expect, test } from '@playwright/test';

test.describe('ZIP Export Harness', () => {
  test('streaming and buffered zip exports produce valid archives with all entries', async ({ page }) => {
    test.setTimeout(90_000);
    page.on('console', (msg) => console.log('BROWSER LOG:', msg.type(), msg.text()));
    page.on('pageerror', (err) => console.error('BROWSER ERROR:', err));

    await page.goto('/zip-harness');
    await expect(page.locator('main[data-ready="true"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('h1')).toHaveText('ZIP harness');

    // Test streaming export with 3 certificates
    await page.click('#run-stream');
    await expect(page.locator('#log')).toContainText('stream ok', { timeout: 60_000 });

    const streamResult = await page.evaluate(() => window.__zipResult);
    expect(streamResult).toBeDefined();
    expect(streamResult?.error).toBeUndefined();
    expect(streamResult?.mode).toBe('stream');
    expect(streamResult?.bytes).toBeGreaterThan(100_000);
    expect(streamResult?.entries).toHaveLength(4);
    expect(streamResult?.entries).toContain('report.pdf');

    // Test buffered export with 3 certificates
    await page.click('#run-buffered');
    await expect(page.locator('#log')).toContainText('buffered ok', { timeout: 60_000 });

    const bufferedResult = await page.evaluate(() => window.__zipResult);
    expect(bufferedResult).toBeDefined();
    expect(bufferedResult?.error).toBeUndefined();
    expect(bufferedResult?.mode).toBe('buffered');
    expect(bufferedResult?.bytes).toBeGreaterThan(100_000);
    expect(bufferedResult?.entries).toHaveLength(4);
    expect(bufferedResult?.entries).toContain('report.pdf');
  });
});
