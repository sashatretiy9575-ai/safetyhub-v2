import { expect, test, type Page, type Route } from '@playwright/test';

const turnstileApi =
  /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit(?:&.*)?$/u;

async function mockTurnstile(page: Page) {
  const fulfillMock = async (route: Route) => {
    await route.fulfill({
      contentType: 'application/javascript',
      body: `
        (() => {
          let options;
          window.__recoveryTurnstile = { get options() { return options; } };
          window.turnstile = {
            render(container, nextOptions) {
              options = nextOptions;
              const frame = document.createElement('iframe');
              frame.title = 'Mock Cloudflare Turnstile';
              container.appendChild(frame);
              return 'recovery-widget';
            },
            execute() {},
            remove() {},
            reset() {},
          };
        })();
      `,
    });
  };
  await page.route(turnstileApi, fulfillMock);
  await page.route('**/turnstile/v0/api.js*', fulfillMock);
}

async function completeTurnstile(page: Page) {
  await expect(page.getByRole('group', { name: 'Проверка безопасности Cloudflare' })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        Boolean((window as typeof window & { __recoveryTurnstile?: unknown }).__recoveryTurnstile),
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    const harness = (
      window as typeof window & {
        __recoveryTurnstile: { options: { callback: (token: string) => void } };
      }
    ).__recoveryTurnstile;
    harness.options.callback('recovery-test-token');
  });
}

async function waitForHydration(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

test('mobile recovery stays in the PWA from email through code to the new password form', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockTurnstile(page);

  let sendBody: unknown;
  let verificationAttempts = 0;
  await page.route('**/api/auth/password/recovery', async (route) => {
    sendBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sent: true }),
    });
  });
  await page.route('**/api/auth/password/recovery/verify', async (route) => {
    verificationAttempts += 1;
    const body = route.request().postDataJSON() as { code?: string };
    await route.fulfill({
      status: verificationAttempts === 1 ? 400 : 200,
      contentType: 'application/json',
      body: JSON.stringify(
        verificationAttempts === 1
          ? { error: 'RECOVERY_CODE_INVALID' }
          : { verified: true, receivedCode: body.code },
      ),
    });
  });

  await page.goto('/auth/reset-password');
  await waitForHydration(page);
  await page.getByLabel('Email').fill('User@Example.com');
  await page.getByRole('button', { name: 'Получить код' }).click();
  await completeTurnstile(page);

  await expect(page.getByLabel('Код из письма')).toBeVisible();
  expect(sendBody).toEqual({
    email: 'user@example.com',
    captchaToken: 'recovery-test-token',
  });
  await page.getByLabel('Код из письма').fill('00 00-00');
  await expect(page.getByLabel('Код из письма')).toHaveValue('000000');
  await page.getByRole('button', { name: 'Подтвердить код' }).click();
  await expect(page.locator('p[role="alert"]')).toContainText('Код неверен или уже истёк');
  await expect(page.getByLabel('Код из письма')).toHaveValue('');
  await expect(page.getByLabel('Код из письма')).toBeFocused();

  await page.getByLabel('Код из письма').fill('123456');
  await page.getByRole('button', { name: 'Подтвердить код' }).click();
  await expect(page.getByRole('heading', { name: 'Придумайте новый пароль' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Новый пароль', exact: true })).toBeVisible();
  await expect(
    page.getByRole('textbox', { name: 'Повторите новый пароль', exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/reset-password$/u);

  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test('an interrupted verification keeps email and code available for retry', async ({ page }) => {
  await page.route('**/api/auth/password/recovery/verify', (route) => route.abort('failed'));
  await page.goto('/auth/reset-password');
  await waitForHydration(page);
  await page.getByRole('button', { name: 'У меня уже есть код' }).click();
  await expect(page.getByLabel('Код из письма')).toBeVisible();
  await page.getByLabel('Email').fill('user@example.com');
  await page.getByLabel('Код из письма').fill('123456');
  await page.getByRole('button', { name: 'Подтвердить код' }).click();

  await expect(page.locator('p[role="alert"]')).toContainText('Не удалось связаться с сервером');
  await expect(page.getByLabel('Email')).toHaveValue('user@example.com');
  await expect(page.getByLabel('Код из письма')).toHaveValue('123456');
  await expect(page.getByRole('button', { name: 'Подтвердить код' })).toBeEnabled();
});

test('a restarted PWA restores the code-entry stage without storing the code', async ({ page }) => {
  await page.addInitScript(
    ({ key, sentAt }) => {
      sessionStorage.setItem(
        key,
        JSON.stringify({ email: 'returning@example.com', stage: 'code', sentAt }),
      );
    },
    { key: 'safetyhub-password-recovery-attempt', sentAt: Date.now() },
  );

  await page.goto('/auth/reset-password');
  await waitForHydration(page);
  await expect(page.getByLabel('Email')).toHaveValue('returning@example.com');
  await expect(page.getByLabel('Код из письма')).toBeVisible();
  await expect(page.getByLabel('Код из письма')).toHaveValue('');
  await expect(page.getByLabel('Код из письма')).toBeFocused();
});
