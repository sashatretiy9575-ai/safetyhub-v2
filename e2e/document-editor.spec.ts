import { expect, test, type Page } from '@playwright/test';
import { resetLocalDocumentSettingsQuota } from './helpers/local-document-settings-quota';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

// Each scenario/retry starts with its own synthetic actor budget. The product
// limit remains intact during the scenario and is tested separately.
test.beforeEach(async ({ page }, testInfo) => {
  if (/company protocol|photographed stamp/.test(testInfo.title)) {
    await resetLocalDocumentSettingsQuota(page.request, String(testInfo.project.use.baseURL));
  }
});

// A click that lands before React hydrates is lost, and on a CI runner that window is seconds wide.
async function openEditor(page: Page, url?: string) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
}

/** Two looks a second apart find the very same canvases: whatever was being drawn has landed. */
async function settledCanvases(page: Page) {
  const look = () =>
    page.locator('canvas').evaluateAll((nodes) =>
      nodes.map((node) => {
        node.id ||= 'e2e-canvas-' + Math.random().toString(36).slice(2);
        return node.id;
      }),
    );
  await expect(async () => {
    const seen = await look();
    expect(seen.length).toBeGreaterThan(0);
    await page.waitForTimeout(1_000);
    expect(await look()).toEqual(seen);
  }).toPass({ timeout: 30_000 });
}

test('protected photo route returns JPEG from a real private storage manifest', async ({
  page,
}, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const identity = await (await page.request.get('/api/identity')).json();
  expect(identity.userId).toBeTruthy();
  let photo = await page.request.get('/api/admin/documents/photo/' + identity.userId);
  if (photo.status() === 404) {
    const sharp = (await import('sharp')).default;
    const fixture = await sharp({
      create: { width: 360, height: 360, channels: 3, background: '#738491' },
    })
      .jpeg()
      .toBuffer();
    const upload = await page.request.post('/api/profile/avatar', {
      headers: { origin: base },
      multipart: { avatar: { name: 'local-fixture.jpg', mimeType: 'image/jpeg', buffer: fixture } },
    });
    expect(upload.ok(), await upload.text()).toBeTruthy();
    photo = await page.request.get('/api/admin/documents/photo/' + identity.userId);
  }
  expect(photo.status()).toBe(200);
  expect(photo.headers()['content-type']).toContain('image/jpeg');
  expect(photo.headers()['cache-control']).toContain('no-store');
  expect((await photo.body()).subarray(0, 2).toString('hex')).toBe('ffd8');
});

test('company protocol, individual booklet, persistence and mobile preview', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const base = testInfo.project.use.baseURL;
  if (!base || !['localhost', '127.0.0.1'].includes(new URL(base).hostname))
    throw new Error('LOCAL_ONLY');
  const errors: string[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy|Refused to apply inline style/.test(message.text())
    )
      errors.push(message.text());
  });
  page.on('response', async (response) => {
    if (
      response.request().method() === 'PATCH' &&
      response.status() >= 400 &&
      response.status() !== 409
    ) {
      console.error('Document mutation failed', response.status(), (await response.json()).error);
    }
  });
  const manualNumber = 'EDITOR/' + Date.now();
  // The actions are laid out twice, in the top row of a desktop and under the thumb on a phone; one is shown.
  const saved = page.getByText('Сохранено', { exact: true }).filter({ visible: true });
  page.on('pageerror', (error) => errors.push(error.message));
  await openEditor(page, '/admin/settings/certificate');
  await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible();
  const response = await page.request.get('/api/admin/documents');
  expect(response.ok()).toBeTruthy();
  const initial = await response.json();
  let chosen: { organization: string; course: string; user: string; count: number } | null = null;
  for (const organization of initial.organizations) {
    for (const course of initial.courses) {
      const r = await page.request.get('/api/admin/documents', {
        params: { organization, course: course.slug },
      });
      const result = await r.json();
      const participant = result.participants?.find(
        (p: { certificateId: string | null }) => p.certificateId,
      );
      if (participant) {
        chosen = {
          organization,
          course: course.slug,
          user: participant.userId,
          count: result.participants.length,
        };
        break;
      }
    }
    if (chosen) break;
  }
  expect(chosen, 'seeded company must include an issued certificate').not.toBeNull();
  const originalCompany = await (
    await page.request.get('/api/admin/documents', { params: chosen! })
  ).json();
  const originalCertificateId = originalCompany.participants.find(
    (p: { userId: string }) => p.userId === chosen!.user,
  ).certificateId;
  const originalMetadata = await (
    await page.request.get(`/api/certificates/${originalCertificateId}/metadata`)
  ).json();
  expect(
    originalMetadata.branding.documentDefaults?.insertWidthCm,
    'seeded issuance must capture insert width before its immutable snapshot is created',
  ).toBeGreaterThan(0);
  expect(
    originalMetadata.branding.documentDefaults?.insertHeightCm,
    'seeded issuance must capture insert height before its immutable snapshot is created',
  ).toBeGreaterThan(0);
  await openEditor(
    page,
    '/admin/settings/certificate?' +
      new URLSearchParams({
        organization: chosen!.organization,
        course: chosen!.course,
        user: chosen!.user,
      }),
  );
  await expect(page.getByRole('button', { name: 'Изменить', exact: true })).toBeVisible();
  // Rare settings are one line each until opened; what was open survives a reload.
  await page.getByRole('radio', { name: 'Удостоверение', exact: true }).click();
  await page.getByRole('button', { name: /^Размер вкладыша/ }).click();
  // A size typed in millimetres is named at its field and is never sent to be refused.
  let refusedSaves = 0;
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().endsWith('/api/admin/settings/certificate'))
      refusedSaves++;
  });
  const spreadWidth = page.getByLabel('Общая ширина разворота, см', { exact: true });
  await spreadWidth.fill('320');
  await expect(page.getByRole('button', { name: /^Размер вкладыша/ })).toContainText(
    'Общая ширина вкладыша: от 8 до 60 см',
  );
  await expect(spreadWidth).toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Общая ширина вкладыша: от 8 до 60 см', visible: true })
      .first(),
  ).toBeVisible();
  await expect(spreadWidth).toBeFocused();
  expect(refusedSaves).toBe(0);
  await spreadWidth.fill('32');
  await page.getByLabel('Высота, см', { exact: true }).fill('10');
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
  // The chip over the pages says which document they are: this one is issued and frozen.
  await expect(
    page.getByText(`· № ${originalMetadata.certificateNumber}`).filter({ visible: true }),
  ).toHaveText(/^Выдано \d{2}\.\d{2}\.\d{4} · № /);
  await page.getByRole('radio', { name: 'Протокол', exact: true }).click();
  // «Организация» where the program has a profile, «Организация и комиссия» where it has none.
  await page.getByRole('button', { name: /^Организация/ }).click();
  // The name of the number says whether it follows the date; whichever it says, it is one field.
  const protocolDate = page.getByLabel('Дата протокола', { exact: true });
  const protocolNumber = page.getByLabel(/^Номер протокола/);
  await protocolDate.fill('2026-09-08');
  const numberByDate = page.getByRole('button', { name: 'Номер по дате', exact: true });
  await expect(numberByDate).toHaveAttribute('title', 'Номер по дате: 08.09');
  await numberByDate.click();
  await expect(page.getByLabel('Номер протокола · по дате', { exact: true })).toHaveValue('08.09');
  await protocolNumber.fill(manualNumber);
  await expect(page.getByLabel('Номер протокола', { exact: true })).toHaveValue(manualNumber);
  await protocolDate.fill('2026-09-09');
  await expect(protocolNumber).toHaveValue(manualNumber);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await openEditor(page);
  await expect(protocolNumber).toHaveValue(manualNumber);
  await expect(protocolDate).toHaveValue('2026-09-09');
  const originalReviewer = await page.getByLabel('Проверяющий', { exact: true }).inputValue();
  const changedReviewer = 'Проверяющий теста ' + Date.now();
  await page.getByLabel('Проверяющий', { exact: true }).fill(changedReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await openEditor(page);
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue(changedReviewer);
  const company = await (
    await page.request.get('/api/admin/documents', { params: chosen! })
  ).json();
  const certificateId = company.participants.find(
    (p: { userId: string }) => p.userId === chosen!.user,
  ).certificateId;
  const refreshed = await (
    await page.request.get(`/api/certificates/${certificateId}/metadata`)
  ).json();
  expect(refreshed.branding).toEqual(originalMetadata.branding);
  expect(refreshed.branding.protocolNumber).not.toBe(manualNumber);
  expect(refreshed.education).toEqual(originalMetadata.education);
  expect(refreshed.photoUrl).toEqual(originalMetadata.photoUrl);
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  const settings = (await (await page.request.get('/api/admin/settings/certificate')).json())
    .settings;
  const concurrent = await page.request.patch('/api/admin/settings/certificate', {
    headers: { origin: base },
    data: {
      expectedVersion: settings.version,
      documentDefaults: { ...settings.documentDefaults, reviewerName: 'Другой администратор' },
    },
  });
  const concurrentBody = await concurrent.text();
  expect(
    concurrent.ok(),
    `Concurrent settings update returned ${concurrent.status()}: ${concurrentBody}`,
  ).toBeTruthy();
  await page.getByLabel('Проверяющий', { exact: true }).fill('Сохранённый черновик');
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(
    page.getByText(/Настройки изменил другой администратор/).filter({ visible: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Проверяющий', { exact: true })).toHaveValue('Сохранённый черновик');
  await page.getByLabel('Проверяющий', { exact: true }).fill(originalReviewer);
  await page.getByRole('button', { name: 'Сохранить настройки', exact: true }).click();
  await expect(saved).toBeVisible();
  await page.getByRole('radio', { name: 'Удостоверение', exact: true }).click();
  await expect(page.locator('canvas')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeEnabled();
  await page.setViewportSize({ width: 240, height: 812 });
  await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
  // Going to the fields and back draws nothing again: the very same canvas is still on the page.
  await settledCanvases(page);
  const keptCanvas = await page.locator('canvas').first().getAttribute('id');
  for (let round = 0; round < 2; round++) {
    await page.getByRole('radio', { name: 'Поля', exact: true }).click();
    await expect(page.locator('canvas').first()).toBeHidden();
    await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
  }
  await settledCanvases(page);
  await expect(page.locator('canvas').first()).toHaveAttribute('id', keptCanvas!);
  const halves = page.getByRole('radiogroup', { name: 'Половина разворота', exact: true });
  await halves.getByRole('radio', { name: 'Правая половина', exact: true }).click();
  expect(
    await page.locator('.document-insert').evaluate((el) => getComputedStyle(el).transform),
  ).not.toBe('none');
  await halves.getByRole('radio', { name: 'Левая половина', exact: true }).click();
  // The half slides into place; the check waits for it to arrive.
  await expect
    .poll(() => page.locator('.document-insert').evaluate((el) => getComputedStyle(el).transform))
    .toBe('none');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('booklet-desktop.png'), fullPage: true });
  // A wider frame redraws the sheet at the new sharpness; the picture is taken of the settled canvas.
  await expect(async () => {
    await page
      .locator('canvas')
      .first()
      .screenshot({ path: testInfo.outputPath('booklet-side-1.png'), timeout: 5_000 });
  }).toPass();
  const downloadEvent = page.waitForEvent('download', { timeout: 45_000 });
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
  const draftPerson = company.participants.find(
    (p: { certificateId: string | null }) => !p.certificateId,
  );
  if (draftPerson) {
    await page.getByRole('radio', { name: 'Удостоверение', exact: true }).click();
    await page.getByLabel('Сотрудник', { exact: true }).click();
    await page.getByRole('button', { name: draftPerson.fullName, exact: true }).click();
    await expect(page.getByText('Новая выдача', { exact: true })).toBeVisible();
    await expect(page.locator('canvas')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Скачать PDF', exact: true })).toBeDisabled();
    await page.getByRole('radio', { name: 'Протокол', exact: true }).click();
  }
  await page.setViewportSize({ width: 240, height: 740 });
  await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: testInfo.outputPath('editor-mobile.png'), fullPage: true });
  for (const width of [240, 320, 375, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `overflow at ${width}`,
    ).toBeTruthy();
    await page.screenshot({ path: testInfo.outputPath(`editor-${width}.png`), fullPage: true });
    if (width < 1024) {
      await page.getByRole('radio', { name: 'Поля', exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBeTruthy();
      expect(
        await page
          .locator('.document-editor button')
          .evaluateAll((buttons) =>
            buttons
              .filter((b) => b.getBoundingClientRect().height > 0)
              .every((b) => b.scrollHeight <= b.clientHeight + 1),
          ),
      ).toBeTruthy();
      await page.screenshot({ path: testInfo.outputPath(`fields-${width}.png`), fullPage: true });
      if (width === 240) {
        await page.setViewportSize({ width, height: 390 });
        await protocolNumber.focus();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBeTruthy();
        await page.setViewportSize({ width, height: 812 });
      }
      await page.getByRole('radio', { name: 'Предпросмотр', exact: true }).click();
    }
  }
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});

test('a photographed stamp becomes a transparent picture, stays until replaced and can be taken off', async ({
  page,
}, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const sharp = (await import('sharp')).default;
  const settings = async () =>
    (await (await page.request.get('/api/admin/settings/certificate')).json()).settings;
  const stored = (version: number) =>
    page.request.get(`/certificate-assets/image?kind=stamp&v=${version}`);
  const before = await settings();
  const original = before.hasStamp ? await (await stored(before.version)).body() : null;
  // A sheet photographed under a lamp: a blue ring on unevenly lit paper, no transparency at all.
  const sheet = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="320"><defs><linearGradient id="l"><stop offset="0" stop-color="#f4f1ea"/><stop offset="1" stop-color="#c9c6c0"/></linearGradient></defs><rect width="420" height="320" fill="url(#l)"/><circle cx="210" cy="160" r="96" fill="none" stroke="#2f4fb4" stroke-width="9"/></svg>',
    ),
  )
    .jpeg({ quality: 90 })
    .toBuffer();
  // The persisted RPC quota must return its retry contract, not a generic 500.
  // Only the disposable local actor's bucket is set; product limits are unchanged.
  await resetLocalDocumentSettingsQuota(page.request, base, 10);
  try {
    const limited = await page.request.put('/api/admin/settings/certificate/image?kind=stamp', {
      headers: { origin: base, 'content-type': 'image/png' },
      data: await sharp(sheet).png().toBuffer(),
    });
    expect(limited.status()).toBe(429);
    const quota = await limited.json();
    expect(quota.error).toBe('RATE_LIMITED');
    expect(quota.retryAfter).toBeGreaterThan(0);
    expect(limited.headers()['retry-after']).toBe(String(quota.retryAfter));
    expect((await settings()).version).toBe(before.version);
  } finally {
    await resetLocalDocumentSettingsQuota(page.request, base);
  }
  try {
    await openEditor(page, '/admin/settings/certificate?tab=certificate');
    await page.getByRole('button', { name: /^Подписи и печать/ }).click();
    // The settings' own stamp has a tile only where no program has a profile. Where
    // profiles exist the section is the registry of their images (its own spec), and
    // the stamp of the settings is reached through its route alone.
    const stampTile = page.getByRole('button', { name: /^Печать: (?:загрузить|заменить)$/ });
    const registryTile = page.getByRole('button', { name: /^(?:Загрузить|Заменить)$/ });
    await expect(stampTile.or(registryTile).first()).toBeVisible();
    const legacy = (await stampTile.count()) > 0;
    if (legacy) {
      const chooser = page.waitForEvent('filechooser');
      await stampTile.click();
      const upload = page.waitForResponse(
        (response) =>
          response.url().includes('/api/admin/settings/certificate/image') &&
          response.request().method() === 'PUT',
      );
      await (await chooser).setFiles({ name: 'sheet.jpg', mimeType: 'image/jpeg', buffer: sheet });
      expect((await upload).status()).toBe(200);
    } else {
      // Taking the paper off a photograph is the browser's work; the route takes the cut-out it makes.
      const cutOut = await sharp(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="320"><circle cx="210" cy="160" r="96" fill="none" stroke="#2f4fb4" stroke-width="9"/></svg>',
        ),
      )
        .png()
        .toBuffer();
      const upload = await page.request.put('/api/admin/settings/certificate/image?kind=stamp', {
        headers: { origin: base, 'content-type': 'image/png' },
        data: cutOut,
      });
      expect(upload.status(), await upload.text()).toBe(200);
    }
    const uploaded = await settings();
    expect(uploaded.hasStamp).toBe(true);
    expect(uploaded.version).toBeGreaterThan(before.version);
    const image = await stored(uploaded.version);
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');
    const { data, info } = await sharp(await image.body())
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    // The paper is gone, the ring is ink: a clear centre and an opaque stroke.
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3] ?? 0;
    expect(alpha(Math.floor(info.width / 2), Math.floor(info.height / 2))).toBe(0);
    expect(
      Math.max(
        ...Array.from({ length: info.width }, (_, x) => alpha(x, Math.floor(info.height / 2))),
      ),
    ).toBeGreaterThan(200);
    // A historical URL keeps its own exact bytes (or its original absence).
    // It must never resolve to a signature uploaded after issuance.
    const outdated = await stored(before.version);
    if (original) {
      expect(outdated.status()).toBe(200);
      expect(outdated.headers()['cache-control']).toContain('private');
      expect(Buffer.compare(await outdated.body(), original)).toBe(0);
    } else expect(outdated.status()).toBe(404);
    if (legacy) {
      await openEditor(page);
      await expect(
        page.getByRole('button', { name: 'Печать: заменить', exact: true }),
      ).toBeVisible();
      const removal = page.waitForResponse(
        (response) =>
          response.url().includes('/api/admin/settings/certificate/image') &&
          response.request().method() === 'DELETE',
      );
      await page.getByRole('button', { name: 'Печать: убрать', exact: true }).click();
      // Every document issued from now on changes, so the editor asks first.
      await page.getByRole('button', { name: 'Убрать', exact: true }).click();
      expect((await removal).status()).toBe(200);
      await expect(
        page.getByRole('button', { name: 'Печать: загрузить', exact: true }),
      ).toBeVisible();
    } else {
      const removal = await page.request.delete(
        '/api/admin/settings/certificate/image?kind=stamp',
        { headers: { origin: base } },
      );
      expect(removal.status(), await removal.text()).toBe(200);
    }
    expect((await settings()).hasStamp).toBe(false);
    const retained = await stored(uploaded.version);
    expect(retained.status()).toBe(200);
    expect(retained.headers()['cache-control']).toContain('private');
    expect(Buffer.compare(await retained.body(), await image.body())).toBe(0);
    const refused = await page.request.put('/api/admin/settings/certificate/image?kind=stamp', {
      headers: { origin: base, 'content-type': 'image/png' },
      data: Buffer.from('not a picture at all'),
    });
    expect(refused.status()).toBe(400);
  } finally {
    if (original)
      await page.request.put('/api/admin/settings/certificate/image?kind=stamp', {
        headers: { origin: base, 'content-type': 'image/png' },
        data: original,
      });
  }
});

test('a slow navigation dims the viewport with a centred loader and clears on completion', async ({
  page,
}, testInfo) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/admin\/employees(?:\?|$)/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('/admin/account');
  await page
    .getByRole('link', { name: 'Сотрудники', exact: true })
    .filter({ visible: true })
    .click({ noWaitAfter: true });
  try {
    const overlay = page.getByRole('status', { name: 'Loading', exact: true }).first();
    await expect(overlay).toBeVisible({ timeout: 1000 });
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await overlay.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const spinner = element.querySelector('.animate-spin')!.getBoundingClientRect();
        const panel = element.firstElementChild!.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
          panelWidth: panel.width,
          panelHeight: panel.height,
          centreX: spinner.x + spinner.width / 2,
          centreY: spinner.y + spinner.height / 2,
          background: style.backgroundColor,
          pointerEvents: style.pointerEvents,
        };
      });
      expect(geometry.left).toBe(0);
      expect(geometry.top).toBe(0);
      expect(geometry.width).toBe(width);
      expect(geometry.height).toBe(900);
      expect(geometry.panelWidth).toBe(96);
      expect(geometry.panelHeight).toBe(96);
      expect(geometry.centreX).toBeCloseTo(width / 2, 0);
      expect(geometry.centreY).toBeCloseTo(450, 0);
      expect(geometry.background).toMatch(/0\.35/);
      expect(geometry.pointerEvents).toBe('none');
      await page.screenshot({ path: testInfo.outputPath(`navigation-loader-${width}.png`) });
    }
  } finally {
    release();
  }
  await expect(page.getByRole('heading', { name: 'Сотрудники', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: 'Loading', exact: true })).toHaveCount(0);
});

test('anonymous and participant cannot read company documents', async ({ browser }, testInfo) => {
  const contextOptions = {
    baseURL: String(testInfo.project.use.baseURL),
    ignoreHTTPSErrors: Boolean(testInfo.project.use.ignoreHTTPSErrors),
  };
  const context = await browser.newContext({
    ...contextOptions,
    storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
  });
  const result = await context.request.get('/api/admin/documents');
  expect([401, 403]).toContain(result.status());
  const foreignCertificate = await context.request.get(
    '/api/certificates/20000000-0000-4000-8000-000000000062/metadata',
  );
  expect([403, 404]).toContain(foreignCertificate.status());
  const foreignPhoto = await context.request.get(
    '/api/certificates/20000000-0000-4000-8000-000000000062/photo',
  );
  expect([403, 404]).toContain(foreignPhoto.status());
  await context.close();
  const anonymous = await browser.newContext({
    ...contextOptions,
    storageState: { cookies: [], origins: [] },
  });
  const denied = await anonymous.request.get('/api/admin/documents', {
    maxRedirects: 0,
  });
  expect([401, 403, 307]).toContain(denied.status());
  if (denied.status() === 307) expect(denied.headers().location).toContain('/auth/login');
  await anonymous.close();
});

test('registered signatures require document ownership or document administration', async ({
  page,
  browser,
}, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const databaseUrl =
    process.env.SAFETYHUB_LOCAL_DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  expect(['localhost', '127.0.0.1']).toContain(new URL(base).hostname);
  expect(['localhost', '127.0.0.1']).toContain(new URL(url).hostname);
  expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  const { randomUUID, createHash } = await import('node:crypto');
  const { createClient } = await import('@supabase/supabase-js');
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const sharp = (await import('sharp')).default;
  const assetId = randomUUID();
  const owner = 'e2e-' + randomUUID();
  // A labelled geometric fixture, never an actual person's signature or a private source file.
  const bytes = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect x="5" y="5" width="230" height="50" fill="none" stroke="blue"/><text x="10" y="35" font-size="12">TEST ${assetId}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const objectKey = sha256 + '.png';
  const client = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const profileId = 'armaturshchik-all';
  const original = (
    await db.query('select * from public.document_profiles where course_slug=$1 and audience=$2', [
      'armaturshchik',
      'all',
    ])
  ).rows[0];
  const activeProfileId = original?.id ?? profileId;
  const body = {
    ...(original?.body ?? {
      id: profileId,
      courseSlug: 'armaturshchik',
      audience: 'all',
      label: 'Арматурщик — тест',
      programName: 'Арматурщик',
      family: 'general',
      hours: null,
      validityMonths: 0,
      protocolText: 'Тестовая программа {program}.',
      decisionText: 'Тестовый профиль.',
      orderNumber: '',
      orderDate: '',
      verificationKind: '',
      stampAssetId: null,
    }),
    commission: [
      { signerId: owner, name: 'Тестовый подписант', position: 'Тестовая комиссия', assetId },
    ],
  };
  let profileInstalled = false;
  const contexts = [];
  try {
    const upload = await client.storage
      .from('document-facsimiles')
      .upload(objectKey, bytes, { contentType: 'image/png', upsert: false });
    expect(upload.error).toBeNull();
    await db.query(
      'insert into public.document_assets(id,owner_id,kind,sha256,object_key) values($1,$2,$3,$4,$5)',
      [assetId, owner, 'signature', sha256, objectKey],
    );
    if (original)
      await db.query('update public.document_profiles set body=$1 where id=$2', [
        body,
        activeProfileId,
      ]);
    else
      await db.query(
        'insert into public.document_profiles(id,course_slug,audience,body) values($1,$2,$3,$4)',
        [activeProfileId, 'armaturshchik', 'all', body],
      );
    profileInstalled = true;
    await openEditor(page, '/admin/settings/certificate?course=armaturshchik');
    const asset = '/certificate-assets/registered?id=' + assetId;
    // The signer's picture is a tile of «Подписи и печать», not a link among the profile's fields.
    await page.getByRole('button', { name: /^Подписи и печать/ }).click();
    await expect(page.locator(`img[src*="${asset}"]`).filter({ visible: true })).toHaveCount(1);
    const allowed = await page.request.get(asset);
    expect(allowed.status()).toBe(200);
    expect(allowed.headers()['content-type']).toBe('image/png');
    expect(Buffer.compare(await allowed.body(), bytes)).toBe(0);
    const anonymous = await browser.newContext({
      baseURL: base,
      ignoreHTTPSErrors: Boolean(testInfo.project.use.ignoreHTTPSErrors),
      storageState: { cookies: [], origins: [] },
    });
    contexts.push(anonymous);
    const denied = await anonymous.request.get(base + asset);
    expect([401, 403]).toContain(denied.status());
    // No issued snapshot references this unique fixture, including on a reused local DB.
    const participant = await browser.newContext({
      storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
    });
    contexts.push(participant);
    const foreign = await participant.request.get(base + asset);
    expect([401, 403, 404]).toContain(foreign.status());
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    try {
      if (profileInstalled) {
        const cleaned = original
          ? await db.query('update public.document_profiles set body=$1 where id=$2 and body=$3', [
              original.body,
              activeProfileId,
              body,
            ])
          : await db.query('delete from public.document_profiles where id=$1 and body=$2', [
              activeProfileId,
              body,
            ]);
        expect(cleaned.rowCount, 'only the unchanged fixture may be restored/removed').toBe(1);
      }
      await db.query(
        'delete from public.document_assets where id=$1 and owner_id=$2 and sha256=$3',
        [assetId, owner, sha256],
      );
      const removed = await client.storage.from('document-facsimiles').remove([objectKey]);
      expect(removed.error).toBeNull();
    } finally {
      await db.end();
    }
  }
});
