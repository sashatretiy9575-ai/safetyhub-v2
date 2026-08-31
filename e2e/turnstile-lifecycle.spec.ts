import { expect, test, type Page, type Route } from '@playwright/test';

const turnstileApi =
  /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit(?:&.*)?$/u;

type TurnstileStats = {
  render: number;
  execute: number;
  remove: number;
  reset: number;
};

async function mockTurnstile(page: Page) {
  const fulfillMock = async (route: Route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        (() => {
          const stats = { render: 0, execute: 0, remove: 0, reset: 0 };
          let options;
          window.__turnstileTest = { stats, get options() { return options; } };
          window.turnstile = {
            render(container, nextOptions) {
              stats.render += 1;
              options = nextOptions;
              const frame = document.createElement('iframe');
              frame.title = 'Mock Cloudflare Turnstile';
              container.appendChild(frame);
              return 'mock-widget';
            },
            execute() { stats.execute += 1; },
            remove() { stats.remove += 1; },
            reset() { stats.reset += 1; },
          };
        })();
      `,
    });
  };
  await page.route(turnstileApi, fulfillMock);
  await page.route('**/turnstile/v0/api.js*', fulfillMock);
}

async function stats(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as typeof window & { __turnstileTest?: unknown }).__turnstileTest),
      ),
    )
    .toBe(true);
  return page.evaluate(
    () =>
      (window as typeof window & { __turnstileTest: { stats: TurnstileStats } }).__turnstileTest
        .stats,
  );
}

async function expectTurnstileDormant(page: Page) {
  await expect(page.locator('script[src*="/turnstile/v0/api.js"]')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Проверка безопасности Cloudflare' })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(() =>
      Boolean((window as typeof window & { __turnstileTest?: unknown }).__turnstileTest),
    ),
  ).toBe(false);
}

async function waitForHydration(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

async function submitLogin(page: Page) {
  await waitForHydration(page);
  await page.getByLabel(/email/i).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Пароль' }).fill('strong-password');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Проверка безопасности Cloudflare' })).toBeVisible();
  await stats(page);
}

async function options(page: Page) {
  await stats(page);
  return page.evaluate(() => {
    const widgetOptions = (
      window as typeof window & {
        __turnstileTest: { options: Record<string, unknown> };
      }
    ).__turnstileTest.options;
    return {
      appearance: widgetOptions.appearance,
      execution: widgetOptions.execution,
      retry: widgetOptions.retry,
      refreshExpired: widgetOptions['refresh-expired'],
      refreshTimeout: widgetOptions['refresh-timeout'],
    };
  });
}

async function callback(page: Page, name: string, ...args: string[]) {
  await page.evaluate(
    ({ callbackName, callbackArgs }) => {
      const harness = (
        window as typeof window & {
          __turnstileTest: { options: Record<string, (...values: string[]) => unknown> };
        }
      ).__turnstileTest;
      const handler = harness.options[callbackName];
      if (!handler) throw new Error(`Turnstile callback was not registered: ${callbackName}`);
      handler(...callbackArgs);
    },
    { callbackName: name, callbackArgs: args },
  );
}

test('Turnstile stays dormant through page load, focus and typing', async ({ page }) => {
  await mockTurnstile(page);
  await page.goto('/auth/login');
  await waitForHydration(page);

  await expectTurnstileDormant(page);
  await page.getByLabel(/email/i).click();
  await page.getByLabel(/email/i).fill('user@example.com');
  await page.getByLabel(/email/i).press('Tab');
  await page.getByRole('textbox', { name: 'Пароль' }).fill('strong-password');
  await expectTurnstileDormant(page);
  await expect(page.getByText('Проверка пройдена')).toHaveCount(0);
});

test('one protected submit executes one native widget and continues exactly once', async ({
  page,
}) => {
  await mockTurnstile(page);
  let loginRequests = 0;
  await page.route('**/api/auth/login', async (route) => {
    loginRequests += 1;
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'INVALID_CREDENTIALS' }),
    });
  });
  await page.goto('/auth/login');
  await submitLogin(page);

  expect(await stats(page)).toEqual({ render: 1, execute: 1, remove: 0, reset: 0 });
  expect(await options(page)).toEqual({
    appearance: 'always',
    execution: 'execute',
    retry: 'never',
    refreshExpired: 'manual',
    refreshTimeout: 'manual',
  });
  expect(loginRequests).toBe(0);

  await callback(page, 'callback', 'test-token');
  await expect.poll(() => loginRequests).toBe(1);
  await callback(page, 'callback', 'duplicate-callback');
  await page.waitForTimeout(100);
  expect(loginRequests).toBe(1);
  await expect(page.getByText('Проверка пройдена')).toHaveCount(0);
});

test('interactive challenge stays visible and failure retry resets before execute', async ({
  page,
}) => {
  await mockTurnstile(page);
  await page.goto('/auth/login');
  await submitLogin(page);

  const challenge = page.getByRole('group', { name: 'Проверка безопасности Cloudflare' });
  await callback(page, 'before-interactive-callback');
  await expect(challenge).toBeVisible();
  await callback(page, 'error-callback', '110200');

  const retry = page.getByRole('button', { name: 'Повторить' });
  await expect(retry).toBeVisible();
  const beforeRetry = await stats(page);
  await retry.click();
  const afterRetry = await stats(page);
  expect(afterRetry.reset).toBe(beforeRetry.reset + 1);
  expect(afterRetry.execute).toBe(beforeRetry.execute + 1);
  expect(afterRetry.render).toBe(beforeRetry.render);
  expect(afterRetry.remove).toBe(beforeRetry.remove);
});

for (const width of [240, 320, 360, 390, 768]) {
  test(`deferred native Turnstile remains visible without overflow at ${width}px`, async ({
    page,
  }) => {
    await mockTurnstile(page);
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/auth/login');
    await expectTurnstileDormant(page);
    await submitLogin(page);

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  });
}
