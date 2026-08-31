import AxeBuilder from '@axe-core/playwright';
import { devices, expect, test } from '@playwright/test';

const publicRoutes = ['/', '/topics', '/blog', '/contacts', '/auth/login'] as const;

for (const route of publicRoutes) {
  test(`public accessibility smoke has no serious violations on ${route}`, async ({ page }) => {
    await page.goto(route);
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
      .analyze();
    const blocking = results.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious',
    );
    expect(
      blocking.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        targets: violation.nodes.map((node) => node.target),
      })),
    ).toEqual([]);
  });
}

for (const theme of ['light', 'dark', 'system'] as const) {
  test(`home hydrates cleanly with ${theme} theme`, async ({ page }) => {
    await page.addInitScript((selectedTheme) => {
      if (selectedTheme === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', selectedTheme);
    }, theme);
    await page.emulateMedia({ colorScheme: theme === 'light' ? 'light' : 'dark' });

    const hydrationErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/hydration|react error #418|server rendered html|did not match/iu.test(text)) {
        hydrationErrors.push(text);
      }
    });
    page.on('pageerror', (error) => {
      if (/hydration|react error #418|server rendered html|did not match/iu.test(error.message)) {
        hydrationErrors.push(error.message);
      }
    });

    await page.goto('/');
    await expect(page.locator('html')).toHaveCSS(
      'color-scheme',
      theme === 'light' ? 'light' : 'dark',
    );
    expect(hydrationErrors).toEqual([]);
  });
}

test.describe('mobile hydration', () => {
  const mobileDevice = devices['Moto G4'];
  test.use({
    viewport: mobileDevice.viewport,
    userAgent: mobileDevice.userAgent,
    deviceScaleFactor: mobileDevice.deviceScaleFactor,
    isMobile: mobileDevice.isMobile,
    hasTouch: mobileDevice.hasTouch,
  });

  test('home hydrates cleanly on a mobile client', async ({ page }) => {
    const hydrationErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (/hydration|react error #418|server rendered html|did not match/iu.test(text)) {
        hydrationErrors.push(text);
      }
    });
    page.on('pageerror', (error) => {
      if (/hydration|react error #418|server rendered html|did not match/iu.test(error.message)) {
        hydrationErrors.push(error.message);
      }
    });

    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Главная' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(hydrationErrors).toEqual([]);
  });
});
