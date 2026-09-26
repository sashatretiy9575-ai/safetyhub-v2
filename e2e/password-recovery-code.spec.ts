import { expect, test } from '@playwright/test';

const retiredPaths = ['/auth/reset-password'];

test('retired password links never render password fields or create a session', async ({ page }) => {
  for (const path of retiredPaths) {
    await page.goto(`${path}?code=untrusted&token_hash=untrusted`);
    await expect(page.getByRole('heading', { name: 'Вход только по коду' })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Получить код на email' })).toHaveAttribute('href', '/auth/login');
  }
});
