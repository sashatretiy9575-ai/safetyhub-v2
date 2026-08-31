import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3100);
// Next normalizes the development request URL to localhost even when the
// listener is bound to 127.0.0.1. Use the same canonical origin in browser
// requests so the production-grade same-origin guard is exercised, not bypassed.
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
          `npm run dev -- --hostname 127.0.0.1 --port ${port}`,
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
