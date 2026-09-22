import { expect, test, type Page } from '@playwright/test';
import { resetLocalDocumentSettingsQuota } from './helpers/local-document-settings-quota';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

// Each scenario/retry that saves settings starts with its own synthetic actor
// budget. The product limit remains intact and is tested separately.
test.beforeEach(async ({ page }, testInfo) => {
  if (/set up once|«Общее»/.test(testInfo.title)) {
    await resetLocalDocumentSettingsQuota(page.request, String(testInfo.project.use.baseURL));
  }
});

const LOCAL = ['localhost', '127.0.0.1'];

// A click that lands before React hydrates is lost, and on a CI runner that window is seconds wide.
async function openPage(page: Page, url?: string) {
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

/** A labelled geometric fixture, never an actual person's signature or seal. */
async function fixturePng(label: string, colour = '#1d3fa8') {
  const sharp = (await import('sharp')).default;
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><circle cx="120" cy="60" r="50" fill="none" stroke="${colour}" stroke-width="6"/><text x="40" y="66" font-size="14" fill="${colour}">${label}</text></svg>`,
    ),
  )
    .png()
    .toBuffer();
}

async function saveCourse(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/documents/courses/') &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Сохранено' }).first()).toBeVisible();
}

/** The seed's setup of a course: the general form, one category, the form's hours. */
async function chooseGeneralForm(page: Page) {
  await page.getByRole('button', { name: 'Форма протокола' }).click();
  await page.getByRole('button', { name: 'Общий', exact: true }).click();
  await page.getByRole('radio', { name: 'Одна', exact: true }).click();
  const hours = page.getByRole('spinbutton', { name: 'Часы', exact: true });
  if (await hours.inputValue()) await hours.fill('');
}

test('a course is set up once in «Документы»: its form, two categories, the preview', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const base = String(testInfo.project.use.baseURL);
  if (!LOCAL.includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  const errors: string[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Content Security Policy|Refused to apply inline style/.test(message.text())
    )
      errors.push(message.text());
  });

  await page.goto('/admin/documents');
  await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible();
  await page.getByRole('link', { name: /^Пожарная безопасность/u }).click();
  await expect(page).toHaveURL(/\/admin\/documents\/pozharnaya-bezopasnost$/u);
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
  await settledCanvases(page);
  // A retry may find the course as an earlier attempt left it: start from the seed's.
  await chooseGeneralForm(page);
  if (await page.getByRole('button', { name: 'Сохранить', exact: true }).isEnabled())
    await saveCourse(page);

  await page.getByRole('button', { name: 'Форма протокола' }).click();
  await page.getByRole('button', { name: 'ПТМ', exact: true }).click();
  await page.getByRole('radio', { name: 'ИТР и рабочие', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Часы, ИТР' }).fill('40');
  await expect(page.getByRole('spinbutton', { name: 'Часы, Рабочие' })).toHaveAttribute(
    'placeholder',
    '10',
  );
  await saveCourse(page);

  // It holds after a reload, and the list of courses says so.
  await openPage(page);
  await expect(page.getByRole('radio', { name: 'ИТР и рабочие', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('spinbutton', { name: 'Часы, ИТР' })).toHaveValue('40');
  await expect(page.getByRole('button', { name: 'Форма протокола' })).toContainText('ПТМ');
  await page.goto('/admin/documents');
  await expect(page.getByRole('link', { name: /^Пожарная безопасность/u })).toContainText(
    'ПТМ · ИТР 40 ч, рабочие 10 ч · корочка общая',
  );

  // A phone: nothing wider than the screen, the booklet shows half at a time.
  await page.setViewportSize({ width: 320, height: 800 });
  await openPage(page, '/admin/documents/pozharnaya-bezopasnost?preview=booklet');
  await expect(page.getByRole('radio', { name: 'Корочка', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(page.getByRole('radiogroup', { name: 'Половина разворота' })).toBeVisible();
  await settledCanvases(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath('course-320.png'), fullPage: true });

  // Back as it was: the general form, one category.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openPage(page, '/admin/documents/pozharnaya-bezopasnost');
  await chooseGeneralForm(page);
  await saveCourse(page);
  expect(errors).toEqual([]);
});

test('«Общее»: the stamp is uploaded, drawn once saved, and nobody else can read it', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(30_000);
  const base = String(testInfo.project.use.baseURL);
  if (!LOCAL.includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  await openPage(page, '/admin/documents/common');

  const uploaded = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/documents/assets') &&
      response.request().method() === 'PUT',
  );
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: /^Печать: (?:загрузить|заменить)$/u }).click();
  await (await chooser).setFiles({
    name: 'stamp.png',
    mimeType: 'image/png',
    buffer: await fixturePng('TEST ' + Date.now()),
  });
  const answer = await uploaded;
  expect(answer.status(), await answer.text()).toBe(200);
  const stampId = ((await answer.json()) as { asset: { id: string } }).asset.id;
  const address = '/certificate-assets/registered?id=' + stampId;
  await expect(page.locator(`img[src="${address}"]`)).toBeVisible();

  // The picture is drawn once «Общее» is saved: leaving now asks first.
  await page.getByRole('link', { name: 'К документам' }).click();
  await expect(page.getByRole('dialog', { name: 'Уйти без сохранения?' })).toBeVisible();
  await page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/documents\/common$/u);

  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/settings/certificate') &&
      response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  expect(
    ((await response.json()) as { settings: { documentCommission: { stampAssetId: string } } })
      .settings.documentCommission.stampAssetId,
  ).toBe(stampId);
  await page.goto('/admin/documents');
  await expect(page.getByRole('link', { name: /^Общее/u })).not.toContainText('нет печати');

  const allowed = await page.request.get(address);
  expect(allowed.status()).toBe(200);
  expect(allowed.headers()['content-type']).toBe('image/png');
  const contextOptions = {
    baseURL: base,
    ignoreHTTPSErrors: Boolean(testInfo.project.use.ignoreHTTPSErrors),
  };
  const anonymous = await browser.newContext({
    ...contextOptions,
    storageState: { cookies: [], origins: [] },
  });
  expect([401, 403]).toContain((await anonymous.request.get(address)).status());
  await anonymous.close();
  // No issued document of the participant draws this fixture.
  const participant = await browser.newContext({
    ...contextOptions,
    storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
  });
  expect([401, 403, 404]).toContain((await participant.request.get(address)).status());
  await participant.close();
});

test('the address of the old editor lands on «Документы»', async ({ page }) => {
  await page.goto('/admin/settings/certificate?course=biot&tab=certificate');
  await expect(page).toHaveURL(/\/admin\/documents\/biot\?preview=booklet$/u);
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Корочка', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.goto('/admin/settings/certificate');
  await expect(page).toHaveURL(/\/admin\/documents$/u);
  await expect(page.getByRole('heading', { name: 'Документы', exact: true })).toBeVisible();
});

test('issuance prints the sitting chosen for it, and the archive carries it', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const base = String(testInfo.project.use.baseURL);
  const databaseUrl =
    process.env.SAFETYHUB_LOCAL_DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  if (!LOCAL.includes(new URL(base).hostname)) throw new Error('LOCAL_ONLY');
  expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  let attestationId: string;
  try {
    const ready = await db.query(
      "select attestation_id from private.admin_attestation_rows where certificate_state='ready' order by attestation_id limit 1",
    );
    expect(ready.rows.length, 'the seeded workspace has a result ready to issue').toBe(1);
    attestationId = ready.rows[0].attestation_id;
  } finally {
    await db.end();
  }
  const yesterday = new Date(Date.now() - 86_400_000)
    .toLocaleDateString('en-CA', { timeZone: 'Asia/Oral' })
    .slice(0, 10);
  const issued = await page.request.post('/api/admin/attestations/actions', {
    headers: { origin: base },
    data: {
      action: 'issue',
      attestationIds: [attestationId],
      idempotencyKey: crypto.randomUUID(),
      protocolDate: yesterday,
      protocolNumber: 'E2E-7',
    },
  });
  expect(issued.status(), await issued.text()).toBe(200);
  const item = ((await issued.json()) as { items: { status: string; reason: string | null }[] })
    .items[0];
  expect(item, JSON.stringify(item)).toMatchObject({ status: 'completed' });

  const archived = await page.request.post('/api/admin/attestations/export', {
    headers: { origin: base },
    data: { attestationIds: [attestationId] },
  });
  expect(archived.status(), await archived.text()).toBe(200);
  const metadata = (await archived.json()) as {
    items: { certificateId: string; branding: { protocolNumber: string; protocolDate: string } }[];
  };
  expect(metadata.items[0]?.branding).toMatchObject({
    protocolNumber: 'E2E-7',
    protocolDate: yesterday,
  });
  const single = await page.request.get(
    `/api/certificates/${metadata.items[0]!.certificateId}/metadata`,
  );
  expect(single.status()).toBe(200);
  expect(((await single.json()) as { branding: unknown }).branding).toEqual(
    metadata.items[0]!.branding,
  );
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

test('anonymous and participant can neither read nor change documents', async ({
  browser,
}, testInfo) => {
  const base = String(testInfo.project.use.baseURL);
  const contextOptions = {
    baseURL: base,
    ignoreHTTPSErrors: Boolean(testInfo.project.use.ignoreHTTPSErrors),
  };
  const someone = '00000000-0000-4000-8000-000000000001';
  const participant = await browser.newContext({
    ...contextOptions,
    storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
  });
  const read = await participant.request.get(
    `/api/admin/documents/person/${someone}?course=${someone}`,
  );
  expect([401, 403]).toContain(read.status());
  const write = await participant.request.put(`/api/admin/documents/courses/${someone}`, {
    headers: { origin: base },
    data: {},
  });
  expect([401, 403]).toContain(write.status());
  const note = await participant.request.put('/api/admin/documents/notes', {
    headers: { origin: base },
    data: { userId: someone, courseSlug: 'biot', notes: 'x' },
  });
  expect([401, 403]).toContain(note.status());
  const foreignCertificate = await participant.request.get(
    '/api/certificates/20000000-0000-4000-8000-000000000062/metadata',
  );
  expect([403, 404]).toContain(foreignCertificate.status());
  const foreignPhoto = await participant.request.get(
    '/api/certificates/20000000-0000-4000-8000-000000000062/photo',
  );
  expect([403, 404]).toContain(foreignPhoto.status());
  await participant.close();
  const anonymous = await browser.newContext({
    ...contextOptions,
    storageState: { cookies: [], origins: [] },
  });
  const denied = await anonymous.request.get(
    `/api/admin/documents/person/${someone}?course=${someone}`,
    { maxRedirects: 0 },
  );
  expect([401, 403, 307]).toContain(denied.status());
  if (denied.status() === 307) expect(denied.headers().location).toContain('/auth/login');
  const page = await anonymous.request.get('/admin/documents', { maxRedirects: 0 });
  expect([302, 303, 307, 401, 403]).toContain(page.status());
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
  expect(LOCAL).toContain(new URL(base).hostname);
  expect(LOCAL).toContain(new URL(url).hostname);
  expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  const { randomUUID, createHash } = await import('node:crypto');
  const { createClient } = await import('@supabase/supabase-js');
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const assetId = randomUUID();
  const owner = 'e2e-' + randomUUID();
  const bytes = await fixturePng('TEST ' + assetId.slice(0, 8));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const objectKey = sha256 + '.png';
  const client = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
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
    const asset = '/certificate-assets/registered?id=' + assetId;
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
    expect([401, 403]).toContain((await anonymous.request.get(base + asset)).status());
    // No issued snapshot references this unique fixture, including on a reused local DB.
    const participant = await browser.newContext({
      storageState: process.env.E2E_PARTICIPANT_STORAGE_STATE,
    });
    contexts.push(participant);
    expect([401, 403, 404]).toContain((await participant.request.get(base + asset)).status());
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    try {
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
