import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
// The listener and the browser must agree on the origin: Next drops proxy
// request headers across a localhost/127.0.0.1 mismatch, which silently turned
// the localized routes back into the Russian shell and made every locale
// assertion meaningless. Same canonical origin on both sides.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['github']] : 'line',
  outputDir: 'test-results/playwright',
  expect: { timeout: 10_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    locale: 'ru-RU',
    timezoneId: 'Asia/Almaty',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER
    ? undefined
    : {
        command:
          process.env.PLAYWRIGHT_SERVER_COMMAND ??
          `npm run dev -- --hostname localhost --port ${port}`,
        env: {
          ...process.env,
          NEXT_PUBLIC_SITE_URL: baseURL,
          NEXT_PUBLIC_TURNSTILE_SITE_KEY:
            process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? '1x00000000000000000000AA',
        },
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
