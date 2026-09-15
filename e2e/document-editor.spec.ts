import { expect, test } from '@playwright/test';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

test('company protocol, individual booklet, persistence and mobile preview', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const base = testInfo.project.use.baseURL;
  if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const errors: string[] = [];
  page.on('response', async response => {
    if (response.request().method() === 'PATCH' && response.status() >= 400 && response.status() !== 409) {
      console.error('Document mutation failed', response.status(), (await response.json()).error);
    }
  });
  const manualNumber = 'EDITOR/' + Date.now();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/admin/settings/certificate');
  await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible();
  const response = await page.request.get('/api/admin/documents');
  expect(response.ok()).toBeTruthy();
  const initial = await response.json();
  let chosen: { organization: string; course: string; user: string; count: number } | null = null;
  for (const organization of initial.organizations) {
    for (const course of initial.courses) {
      const r = await page.request.get('/api/admin/documents', { params: { organization, course: course.slug } });
      const result = await r.json();
      const participant = result.participants?.find((p: { certificateId: string | null }) => p.certificateId);
      if (participant) { chosen = { organization, course: course.slug, user: participant.userId, count: result.participants.length }; break; }
    }
    if (chosen) break;
  }
  expect(chosen, 'seeded company must include an issued certificate').not.toBeNull();
  await page.goto('/admin/settings/certificate?' + new URLSearchParams({ organization: chosen!.organization, course: chosen!.course, user: chosen!.user }));
  await expect(page.getByLabel('Клиент', { exact: true })).toHaveValue(chosen!.user);
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Дата', { exact: true }).fill('2026-09-08');
  await page.getByRole('button', { name: 'Номер по дате', exact: true }).click();
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue('08.09');
  await page.getByLabel('Номер', { exact: true }).fill(manualNumber);
  await page.getByLabel('Дата', { exact: true }).fill('2026-09-09');
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue(manualNumber);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText('Настройки и реквизиты протокола сохранены.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue(manualNumber);
  await expect(page.getByLabel('Дата', { exact: true })).toHaveValue('2026-09-09');
  const originalReviewer = await page.getByLabel('Проверяющий', { exact: true }).inputValue();
  await page.getByLabel('Проверяющий', { exact: true }).fill('Проверяющий локального теста');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText('Настройки и реквизиты протокола сохранены.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue('Проверяющий локального теста');
  const company = await (await page.request.get('/api/admin/documents', { params: chosen! })).json();
  const certificateId = company.participants.find((p: { userId: string }) => p.userId === chosen!.user).certificateId;
  const refreshed = await (await page.request.get(`/api/certificates/${certificateId}/metadata`)).json();
  expect(refreshed.branding.documentDefaults.reviewerName).toBe('Проверяющий локального теста');
  expect(refreshed.branding.protocolNumber).toBe(manualNumber);
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText('Настройки и реквизиты протокола сохранены.')).toBeVisible();
  const settings = (await (await page.request.get('/api/admin/settings/certificate')).json()).settings;
  const concurrent = await page.request.patch('/api/admin/settings/certificate', {
    headers: { origin: 'http://localhost:3100' },
    data: { expectedVersion: settings.version, documentDefaults: { ...settings.documentDefaults, reviewerName: 'Другой администратор' } },
  });
  expect(concurrent.ok()).toBeTruthy();
  await page.getByLabel('Проверяющий', { exact: true }).fill('Сохранённый черновик');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText(/Настройки изменил другой администратор/)).toBeVisible();
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue('Сохранённый черновик');
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText('Настройки и реквизиты протокола сохранены.')).toBeVisible();
  await page.getByRole('button', { name: 'Корочка клиента', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(2, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath('booklet-desktop.png'), fullPage: true });
  for (let i = 0; i < 2; i++) await page.locator('canvas').nth(i).screenshot({ path: testInfo.outputPath(`booklet-side-${i + 1}.png`) });
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toMatch(/\.pdf$/);
  await page.getByRole('button', { name: 'Протокол компании', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('protocol-desktop.png'), fullPage: true });
  const zipEvent = page.waitForEvent('download', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Скачать комплект компании', exact: true }).click();
  expect((await zipEvent).suggestedFilename()).toMatch(/\.zip$/);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('editor-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Увеличить документ', exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('anonymous and participant cannot read company documents', async ({ browser }) => {
  const context = await browser.newContext({ storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE });
  const result = await context.request.get('http://localhost:3100/api/admin/documents');
  expect([401, 403]).toContain(result.status());
  const foreignCertificate = await context.request.get('http://localhost:3100/api/certificates/20000000-0000-4000-8000-000000000062/metadata');
  expect([403, 404]).toContain(foreignCertificate.status());
  await context.close();
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await anonymous.request.get('http://localhost:3100/api/admin/documents', { maxRedirects: 0 });
  expect([401, 403, 307]).toContain(denied.status());
  if (denied.status() === 307) expect(denied.headers().location).toContain('/auth/login');
  await anonymous.close();
});
