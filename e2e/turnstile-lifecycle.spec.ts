import { expect, test, type Page, type Route } from '@playwright/test';

const turnstileApi = /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit(?:&.*)?$/u;

async function mockTurnstile(page: Page) {
  const fulfill = async (route: Route) => route.fulfill({
    contentType: 'application/javascript',
    body: `(() => {
      let options; let executeCount = 0;
      window.__otpTurnstile = { get options() { return options; }, get executeCount() { return executeCount; } };
      window.turnstile = {
        render(container, nextOptions) { options = nextOptions; const frame = document.createElement('iframe'); frame.title = 'Mock Cloudflare Turnstile'; container.appendChild(frame); return 'otp-widget'; },
        execute() { executeCount += 1; }, remove() {}, reset() {},
      };
    })();`,
  });
  await page.route(turnstileApi, fulfill);
  await page.route('**/turnstile/v0/api.js*', fulfill);
}

async function completeTurnstile(page: Page, token: string) {
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __otpTurnstile?: unknown }).__otpTurnstile))).toBe(true);
  await page.evaluate((value) => {
    const harness = (window as unknown as Window & {
      __otpTurnstile: { options: { callback: (token: string) => void } };
    }).__otpTurnstile;
    harness.options.callback(value);
  }, token);
}

test('email OTP executes Turnstile once and sends one request despite a duplicate callback', async ({ page }) => {
  await mockTurnstile(page);
  let requests = 0;
  await page.route('**/api/auth/email-otp/request', async (route) => {
    requests += 1;
    expect(route.request().postDataJSON()).toEqual({ email: 'user@example.com', intent: 'login', captchaToken: 'test-token' });
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sent: true }) });
  });
  await page.goto('/auth/login');
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
  await page.getByLabel('Email').fill('User@Example.com');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await completeTurnstile(page, 'test-token');
  await expect.poll(() => requests).toBe(1);
  await completeTurnstile(page, 'duplicate-token');
  await page.waitForTimeout(100);
  expect(requests).toBe(1);
  await expect(page.getByLabel('Код из письма')).toBeVisible();
});

for (const width of [240, 320, 390, 768]) {
  test(`OTP sign-in remains responsive at ${width}px`, async ({ page }) => {
    await mockTurnstile(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/auth/login');
    const geometry = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    await page.getByLabel('Email').fill('user@example.com');
    await page.getByRole('button', { name: 'Получить код' }).click();
    await expect(page.getByRole('button', { name: 'Получить код' })).toBeVisible();
  });
}
