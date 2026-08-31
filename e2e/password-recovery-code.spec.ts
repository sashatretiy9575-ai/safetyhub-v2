import { expect, test } from '@playwright/test';

const retiredPaths = [
  '/auth/change-password',
  '/auth/reset-password',
  '/auth/update-password',
  '/auth/invite',
];

test('retired password links never render password fields or create a session', async ({ page }) => {
  for (const path of retiredPaths) {
    await page.goto(`${path}?code=untrusted&token_hash=untrusted`);
    await expect(page.getByRole('heading', { name: 'Вход только по коду' })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Получить код на email' })).toHaveAttribute('href', '/auth/login');
  }
});

test('retired password APIs fail closed with the explicit 410 contract', async ({ request }) => {
  for (const path of [
    '/api/auth/login',
    '/api/auth/register',
    '/api/auth/password',
    '/api/auth/password/context',
    '/api/auth/password/recovery',
    '/api/auth/password/recovery/verify',
  ]) {
    const response = await request.post(path, { data: { email: 'user@example.com', password: 'unused' } });
    expect(response.status()).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: 'PASSWORD_AUTH_RETIRED' });
    expect(response.headers()['cache-control']).toContain('no-store');
  }
});
