import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

// A click that lands before React hydrates is lost, and on a CI runner that window is seconds wide.
async function openEditor(page: Page, url?: string) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
}

test('protected photo route returns JPEG from a real private storage manifest', async ({ page }, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const identity = await (await page.request.get('/api/identity')).json();
  expect(identity.userId).toBeTruthy();
  let photo = await page.request.get('/api/admin/documents/photo/' + identity.userId);
  if (photo.status() === 404) {
    const sharp = (await import('sharp')).default;
    const fixture = await sharp({ create: { width: 360, height: 360, channels: 3, background: '#738491' } }).jpeg().toBuffer();
    const upload = await page.request.post('/api/profile/avatar', { headers: { origin: base }, multipart: { avatar: { name: 'local-fixture.jpg', mimeType: 'image/jpeg', buffer: fixture } } });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    photo = await page.request.get('/api/admin/documents/photo/' + identity.userId);
  }
  expect(photo.status()).toBe(200);
  expect(photo.headers()['content-type']).toContain('image/jpeg');
  expect(photo.headers()['cache-control']).toContain('no-store');
  expect((await photo.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
});

test('company protocol, individual booklet, persistence and mobile preview', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const base = testInfo.project.use.baseURL;
  if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const errors: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && /Content Security Policy|Refused to apply inline style/.test(message.text())) errors.push(message.text()); });
  page.on('response', async response => {
    if (response.request().method() === 'PATCH' && response.status() >= 400 && response.status() !== 409) {
      console.error('Document mutation failed', response.status(), (await response.json()).error);
    }
  });
  const manualNumber = 'EDITOR/' + Date.now();
  // The actions are laid out twice, in the top row of a desktop and under the thumb on a phone; one is shown.
  const saved = page.getByText('Сохранено', { exact: true }).filter({ visible: true });
  page.on('pageerror', error => errors.push(error.message));
  await openEditor(page, '/admin/settings/certificate');
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
  const originalCompany = await (await page.request.get('/api/admin/documents', { params: chosen! })).json();
  const originalCertificateId = originalCompany.participants.find((p: { userId: string }) => p.userId === chosen!.user).certificateId;
  const originalMetadata = await (await page.request.get(`/api/certificates/${originalCertificateId}/metadata`)).json();
  await openEditor(page, '/admin/settings/certificate?' + new URLSearchParams({ organization: chosen!.organization, course: chosen!.course, user: chosen!.user }));
  await expect(page.getByRole('button', { name: 'Изменить', exact: true })).toBeVisible();
  // Rare settings are one line each until opened; what was open survives a reload.
  await page.getByRole('radio', { name: 'Корочка', exact: true }).click();
  await page.getByRole('button', { name: /^Размер вкладыша/ }).click();
  // A size typed in millimetres is named at its field and is never sent to be refused.
  let refusedSaves = 0;
  page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/api/admin/settings/certificate')) refusedSaves++; });
  await page.getByLabel('Общая ширина, см', { exact: true }).fill('320');
  await expect(page.getByRole('button', { name: /^Размер вкладыша/ })).toContainText('Общая ширина вкладыша: от 8 до 60 см');
  await expect(page.getByLabel('Общая ширина, см', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Общая ширина вкладыша: от 8 до 60 см', visible: true }).first()).toBeVisible();
  await expect(page.getByLabel('Общая ширина, см', { exact: true })).toBeFocused();
  expect(refusedSaves).toBe(0);
  await page.getByLabel('Общая ширина, см', { exact: true }).fill('32');
  await page.getByLabel('Высота, см', { exact: true }).fill('10');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole('radio', { name: 'Протокол', exact: true }).click();
  await page.getByRole('button', { name: /^Организация и комиссия/ }).click();
  await page.getByLabel('Дата', { exact: true }).fill('2026-09-08');
  await page.getByRole('button', { name: 'Номер по дате', exact: true }).click();
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue('08.09');
  await page.getByLabel('Номер', { exact: true }).fill(manualNumber);
  await page.getByLabel('Дата', { exact: true }).fill('2026-09-09');
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue(manualNumber);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await openEditor(page);
  await expect(page.getByLabel('Номер', { exact: true })).toHaveValue(manualNumber);
  await expect(page.getByLabel('Дата', { exact: true })).toHaveValue('2026-09-09');
  const originalReviewer = await page.getByLabel('Проверяющий', { exact: true }).inputValue();
  const changedReviewer = 'Проверяющий теста ' + Date.now();
  await page.getByLabel('Проверяющий', { exact: true }).fill(changedReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await openEditor(page);
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue(changedReviewer);
  const company = await (await page.request.get('/api/admin/documents', { params: chosen! })).json();
  const certificateId = company.participants.find((p: { userId: string }) => p.userId === chosen!.user).certificateId;
  const refreshed = await (await page.request.get(`/api/certificates/${certificateId}/metadata`)).json();
  expect(refreshed.branding).toEqual(originalMetadata.branding);
  expect(refreshed.branding.protocolNumber).not.toBe(manualNumber);
  expect(refreshed.education).toEqual(originalMetadata.education);
  expect(refreshed.photoUrl).toEqual(originalMetadata.photoUrl);
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  const settings = (await (await page.request.get('/api/admin/settings/certificate')).json()).settings;
  const concurrent = await page.request.patch('/api/admin/settings/certificate', {
    headers: { origin: 'http://localhost:3100' },
    data: { expectedVersion: settings.version, documentDefaults: { ...settings.documentDefaults, reviewerName: 'Другой администратор' } },
  });
  expect(concurrent.ok()).toBeTruthy();
  await page.getByLabel('Проверяющий', { exact: true }).fill('Сохранённый черновик');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(page.getByText(/Настройки изменил другой администратор/).filter({ visible: true })).toBeVisible();
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue('Сохранённый черновик');
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await page.getByRole('radio', { name: 'Корочка', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 240, height: 812 });
  await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
  await page.getByRole('radio', { name: 'Правая', exact: true }).click();
  expect(await page.locator('.document-insert').evaluate(el => getComputedStyle(el).transform)).not.toBe('none');
  await page.getByRole('radio', { name: 'Левая', exact: true }).click();
  // The half slides into place; the check waits for it to arrive.
  await expect.poll(() => page.locator('.document-insert').evaluate(el => getComputedStyle(el).transform)).toBe('none');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('booklet-desktop.png'), fullPage: true });
  // A wider frame redraws the sheet at the new sharpness; the picture is taken of the settled canvas.
  await expect(async () => { await page.locator('canvas').first().screenshot({ path: testInfo.outputPath('booklet-side-1.png'), timeout: 5_000 }); }).toPass();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click();
  const bookletDownload = await downloadEvent;
  expect(bookletDownload.suggestedFilename()).toMatch(/\.pdf$/);
  await bookletDownload.saveAs(testInfo.outputPath('booklet.pdf'));
  await page.getByRole('radio', { name: 'Протокол', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('protocol-desktop.png'), fullPage: true });
  const zipEvent = page.waitForEvent('download', { timeout: 90_000 });
  await page.getByRole('button', { name: 'Скачать комплект компании', exact: true }).click();
  expect((await zipEvent).suggestedFilename()).toMatch(/\.zip$/);
  const draftPerson = company.participants.find((p: { certificateId: string | null }) => !p.certificateId);
  if (draftPerson) {
    await page.getByRole('radio', { name: 'Корочка', exact: true }).click();
    await page.getByLabel('Сотрудник', { exact: true }).click();
    await page.getByRole('button', { name: draftPerson.fullName, exact: true }).click();
    await expect(page.getByText('Удостоверение ещё не выдано', { exact: true })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeDisabled();
    await page.getByRole('radio', { name: 'Протокол', exact: true }).click();
  }
  await page.setViewportSize({ width: 240, height: 740 });
  await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('editor-mobile.png'), fullPage: true });
  for (const width of [240, 320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `overflow at ${width}`).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`editor-${width}.png`), fullPage: true });
    if (width < 1024) {
      await page.getByRole('radio', { name: 'Поля', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      expect(await page.locator('.document-editor button').evaluateAll(buttons => buttons.filter(b => b.getBoundingClientRect().height > 0).every(b => b.scrollHeight <= b.clientHeight + 1))).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`fields-${width}.png`), fullPage: true });
      if (width === 240) {
        await page.setViewportSize({ width, height: 390 });
        await page.getByLabel('Номер', { exact: true }).focus();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
        await page.setViewportSize({ width, height: 812 });
      }
      await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
    }
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a photographed stamp becomes a transparent picture, stays until replaced and can be taken off', async ({ page }, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const sharp = (await import('sharp')).default;
  const settings = async () => (await (await page.request.get('/api/admin/settings/certificate')).json()).settings;
  const stored = (version: number) => page.request.get(`/certificate-assets/image?kind=stamp&v=${version}`);
  const before = await settings();
  const original = before.hasStamp ? await (await stored(before.version)).body() : null;
  // A sheet photographed under a lamp: a blue ring on unevenly lit paper, no transparency at all.
  const sheet = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="420" height="320"><defs><linearGradient id="l"><stop offset="0" stop-color="#f4f1ea"/><stop offset="1" stop-color="#c9c6c0"/></linearGradient></defs><rect width="420" height="320" fill="url(#l)"/><circle cx="210" cy="160" r="96" fill="none" stroke="#2f4fb4" stroke-width="9"/></svg>')).jpeg({ quality: 90 }).toBuffer();
  try {
    await openEditor(page, '/admin/settings/certificate?tab=certificate');
    await page.getByRole('button', { name: /^Печать и подпись/ }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /^Печать: (?:загрузить|заменить)$/ }).click();
    const upload = page.waitForResponse(response => response.url().includes('/api/admin/settings/certificate/image') && response.request().method() === 'PUT');
    await (await chooser).setFiles({ name: 'sheet.jpg', mimeType: 'image/jpeg', buffer: sheet });
    expect((await upload).status()).toBe(200);
    const uploaded = await settings();
    expect(uploaded.hasStamp).toBe(true);
    expect(uploaded.version).toBeGreaterThan(before.version);
    const image = await stored(uploaded.version);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
    const { data, info } = await sharp(await image.body()).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    // The paper is gone, the ring is ink: a clear centre and an opaque stroke.
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3] ?? 0;
    expect(alpha(Math.floor(info.width / 2), Math.floor(info.height / 2))).toBe(0);
    expect(Math.max(...Array.from({ length: info.width }, (_, x) => alpha(x, Math.floor(info.height / 2))))).toBeGreaterThan(200);
    // A historical URL keeps its own exact bytes (or its original absence).
    // It must never resolve to a signature uploaded after issuance.
    const outdated = await stored(before.version);
    if (original) {
      expect(outdated.status()).toBe(200);
      expect(outdated.headers()['cache-control']).toContain('private');
      expect(Buffer.compare(await outdated.body(), original)).toBe(0);
    } else expect(outdated.status()).toBe(404);
    await openEditor(page);
    await expect(page.getByRole('button', { name: 'Печать: заменить', exact: true })).toBeVisible();
    const removal = page.waitForResponse(response => response.url().includes('/api/admin/settings/certificate/image') && response.request().method() === 'DELETE');
    await page.getByRole('button', { name: 'Печать: убрать', exact: true }).click();
    // Every document issued from now on changes, so the editor asks first.
    await page.getByRole('button', { name: 'Убрать', exact: true }).click();
    expect((await removal).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Печать: загрузить', exact: true })).toBeVisible();
    expect((await settings()).hasStamp).toBe(false);
    const retained = await stored(uploaded.version);
    expect(retained.status()).toBe(200);
    expect(retained.headers()['cache-control']).toContain('private');
    expect(Buffer.compare(await retained.body(), await image.body())).toBe(0);
    const refused = await page.request.put('/api/admin/settings/certificate/image?kind=stamp', { headers: { origin: base, 'content-type': 'image/png' }, data: Buffer.from('not a picture at all') });
    expect(refused.status()).toBe(400);
  } finally {
    if (original) await page.request.put('/api/admin/settings/certificate/image?kind=stamp', { headers: { origin: base, 'content-type': 'image/png' }, data: original });
  }
});

test('a slow navigation dims the viewport with a centred loader and clears on completion', async ({ page }, testInfo) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/admin\/employees(?:\?|$)/, async route => {
    await held;
    await route.continue();
  });
  await page.goto('/admin/account');
  await page.getByRole('link', { name: 'Сотрудники', exact: true }).filter({ visible: true }).click({ noWaitAfter: true });
  try {
    const overlay = page.getByRole('status', { name: 'Loading', exact: true }).first();
    await expect(overlay).toBeVisible({ timeout: 1000 });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await overlay.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        const spinner = element.querySelector('.animate-spin')!.getBoundingClientRect();
        const panel = element.firstElementChild!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height, panelWidth: panel.width, panelHeight: panel.height, centreX: spinner.x + spinner.width / 2, centreY: spinner.y + spinner.height / 2, background: style.backgroundColor, pointerEvents: style.pointerEvents };
      });
      expect(geometry.left).toBe(0); expect(geometry.top).toBe(0);
      expect(geometry.width).toBe(width); expect(geometry.height).toBe(900);
      expect(geometry.panelWidth).toBe(96); expect(geometry.panelHeight).toBe(96);
      expect(geometry.centreX).toBeCloseTo(width / 2, 0); expect(geometry.centreY).toBeCloseTo(450, 0);
      expect(geometry.background).toMatch(/0\.35/); expect(geometry.pointerEvents).toBe('none');
      await page.screenshot({ path: testInfo.outputPath(`navigation-loader-${width}.png`) });
    }
  } finally { release(); }
  await expect(page.getByRole('heading', { name: 'Сотрудники', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading', exact: true })).toHaveCount(0);
});

test('anonymous and participant cannot read company documents', async ({ browser }) => {
  const context = await browser.newContext({ storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE });
  const result = await context.request.get('http://localhost:3100/api/admin/documents');
  expect([401, 403]).toContain(result.status());
  const foreignCertificate = await context.request.get('http://localhost:3100/api/certificates/20000000-0000-4000-8000-000000000062/metadata');
  expect([403, 404]).toContain(foreignCertificate.status());
  const foreignPhoto = await context.request.get('http://localhost:3100/api/certificates/20000000-0000-4000-8000-000000000062/photo');
  expect([403, 404]).toContain(foreignPhoto.status());
  await context.close();
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await anonymous.request.get('http://localhost:3100/api/admin/documents', { maxRedirects: 0 });
  expect([401, 403, 307]).toContain(denied.status());
  if (denied.status() === 307) expect(denied.headers().location).toContain('/auth/login');
  await anonymous.close();
});

test('registered signatures require document ownership or document administration', async ({ page, browser }) => {
  await openEditor(page, '/admin/settings/certificate?course=armaturshchik');
  const asset = await page.locator('a[href^="/certificate-assets/registered?id="]').first().getAttribute('href');
  expect(asset).toBeTruthy();
  const allowed = await page.request.get(asset!);
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['content-type']).toBe('image/png');
  const anonymous = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const denied = await anonymous.request.get('http://localhost:3100' + asset);
  expect([401, 403]).toContain(denied.status());
  await anonymous.close();
  // The seeded participant has legacy snapshots, none referencing this newly
  // registered PNG. Knowledge of an opaque asset ID does not grant access.
  const participant = await browser.newContext({ storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE });
  const foreign = await participant.request.get('http://localhost:3100' + asset);
  expect([401, 403, 404]).toContain(foreign.status());
  await participant.close();
});
