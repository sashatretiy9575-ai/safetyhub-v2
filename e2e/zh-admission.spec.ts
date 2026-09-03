import { expect, test } from '@playwright/test';

/**
 * The Chinese path had no end-to-end coverage at all, which is how it stayed
 * broken: registration used to be the application, so a learner reached a test
 * with an empty profile and could never receive a certificate. These checks are
 * deliberately guest-only — they need no seeded session and run in every
 * environment where the ZH rollout flag is on.
 */
const zhRolloutEnabled = process.env.SAFETYHUB_ZH_USERNAME_PASSWORD_ENABLED !== 'false';

test.describe('Chinese admission', () => {
  test.skip(!zhRolloutEnabled, 'ZH username/password rollout is disabled in this environment.');

  test('registration collects only a username and password, in Chinese', async ({ page }) => {
    const response = await page.goto('/zh/auth/login', { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBeTruthy();

    // `/zh/auth/login` is a rewrite that carries its locale in a proxy request
    // header, and Next drops middleware request headers when the browser origin
    // does not match the listener. The dev server is therefore bound to the same
    // host the suite browses (see playwright.config.ts); if that ever regresses,
    // this assertion fails loudly instead of quietly skipping the whole path.
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');

    // Switching to registration must not ask for an email anywhere.
    const registerTab = page.getByRole('button', { name: '创建访问账号' }).first();
    await expect(registerTab).toBeVisible();
    // The tab is server-rendered before its handler is attached, so a click can
    // land on an unhydrated button and do nothing at all. Retry until the panel
    // actually switches instead of asserting once against the login form.
    await expect(async () => {
      await registerTab.click();
      await expect(page.locator('#zh-register-legal')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 15_000 });

    await expect(page.locator('input[type="email"]')).toHaveCount(0);
    await expect(page.getByLabel('拉丁用户名')).toBeVisible();

    // Consent is pre-ticked here as well.
    await expect(page.locator('#zh-register-legal')).toBeChecked();
  });

  test('a guest cannot reach the Chinese onboarding form or a test', async ({ page }) => {
    await page.goto('/zh/onboarding');
    await expect(page).toHaveURL(/\/zh\/auth\/login/u);

    await page.goto('/zh/profile');
    await expect(page).toHaveURL(/\/zh\/auth\/login/u);
  });

  test('the Chinese catalog is public but its tests are not', async ({ page }) => {
    const catalog = await page.goto('/zh/topics', { waitUntil: 'domcontentloaded' });
    expect(catalog?.ok()).toBeTruthy();

    const firstCourse = page.locator('[data-course-card]').first();
    await expect(firstCourse).toBeVisible();
    const href = await firstCourse.getAttribute('href');
    expect(href).toMatch(/^\/zh\/topics\//u);

    await page.goto(`${href}/test`);
    await expect(page).toHaveURL(/\/zh\/auth\/login/u);
  });
});
