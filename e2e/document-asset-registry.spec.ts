import { expect, test, type Page } from '@playwright/test';
import { resetLocalDocumentSettingsQuota } from './helpers/local-document-settings-quota';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

// Every upload and every save is one unit of the administrator's settings
// budget. Each scenario/retry starts with a full one; the limit itself is untouched.
test.beforeEach(async ({ page }, testInfo) => {
  await resetLocalDocumentSettingsQuota(page.request, String(testInfo.project.use.baseURL));
});

// A click that lands before React hydrates is lost, and on a CI runner that window is seconds wide.
async function openCommon(page: Page) {
  await page.goto('/admin/documents/common');
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
}

/** Picks a file through the tile, which is its own button, and returns the registered image. */
async function uploadThroughTile(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent('filechooser');
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/documents/assets') &&
      response.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: new RegExp(`^Подпись: ${name}: (?:загрузить|заменить)$`, 'u') }).click();
  await (await chooser).setFiles({ name: 'signature.png', mimeType: 'image/png', buffer });
  const response = await answered;
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { asset: { id: string; ownerId: string; kind: string } }).asset;
}

async function save(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/admin/settings/certificate') &&
      response.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  await expect(page.getByRole('status').filter({ hasText: 'Сохранено' }).first()).toBeVisible();
}

/** The reads share the administrator's twenty a minute with every other document test. */
async function issuedMetadata(page: Page, certificateId: string) {
  for (let attempt = 0; ; attempt++) {
    const response = await page.request.get(`/api/certificates/${certificateId}/metadata`);
    if (response.status() !== 429 || attempt >= 2) {
      expect(response.status(), await response.text()).toBe(200);
      return response.json();
    }
    await page.waitForTimeout((Number(response.headers()['retry-after']) || 60) * 1_000);
  }
}

test('a new member of the commission signs with an image of their own; issued documents keep theirs', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  page.setDefaultTimeout(30_000);
  const base = String(testInfo.project.use.baseURL);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const databaseUrl =
    process.env.SAFETYHUB_LOCAL_DATABASE_URL ??
    'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  expect(['localhost', '127.0.0.1']).toContain(new URL(base).hostname);
  expect(['localhost', '127.0.0.1']).toContain(new URL(url).hostname);
  expect(databaseUrl).toBe('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  const { randomUUID } = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const sharp = (await import('sharp')).default;

  const token = randomUUID();
  const signerName = 'Тестовый подписант ' + token.slice(0, 8);
  // A labelled geometric fixture, never an actual person's signature. The bars
  // spell the token, so no two runs ever register the same bytes.
  const picture = (colour: string) =>
    sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect x="4" y="4" width="232" height="72" fill="none" stroke="${colour}" stroke-width="4"/>${[
          ...token.replaceAll('-', '').slice(0, 12),
        ]
          .map((digit, at) => {
            const height = 6 + parseInt(digit, 16) * 3;
            return `<rect x="${20 + at * 17}" y="${68 - height}" width="10" height="${height}" fill="${colour}"/>`;
          })
          .join('')}</svg>`,
      ),
    )
      .png()
      .toBuffer();
  const [first, second] = await Promise.all([picture('#1d3fa8'), picture('#0b6b3a')]);
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  const signerOf = async () =>
    (
      await db.query(
        "select signer from public.certificate_settings, jsonb_array_elements(document_commission->'signers') signer where signer->>'name'=$1",
        [signerName],
      )
    ).rows[0]?.signer as { signerId: string; assetId: string | null } | undefined;
  let owner: string | undefined;
  try {
    // An issued document to hold the replacement against.
    const issued = await db.query(
      'select id from public.certificates where revoked_at is null and document_snapshot is not null order by issued_at limit 1',
    );
    expect(issued.rows.length, 'the seeded workspace has an issued certificate').toBe(1);
    const certificateId: string = issued.rows[0].id;
    const issuedBefore = await issuedMetadata(page, certificateId);

    await openCommon(page);
    const members = page.getByRole('textbox', { name: /^Член комиссии \d+$/u });
    const before = await members.count();
    await page.getByRole('button', { name: 'Добавить в комиссию', exact: true }).click();
    await expect(members).toHaveCount(before + 1);
    await members.last().fill(signerName);

    const uploaded = await uploadThroughTile(page, signerName, first);
    expect(uploaded.kind).toBe('signature');
    owner = uploaded.ownerId;
    const firstAddress = '/certificate-assets/registered?id=' + uploaded.id;
    await expect(page.locator(`img[src="${firstAddress}"]`)).toBeVisible();
    await save(page);
    expect(await signerOf()).toMatchObject({ signerId: owner, assetId: uploaded.id });
    const firstServed = await page.request.get(firstAddress);
    expect(firstServed.status()).toBe(200);
    const firstBytes = await firstServed.body();

    // Another picture is another image with another address.
    const replaced = await uploadThroughTile(page, signerName, second);
    expect(replaced.id).not.toBe(uploaded.id);
    expect(replaced.ownerId).toBe(owner);
    const secondAddress = '/certificate-assets/registered?id=' + replaced.id;
    await expect(page.locator(`img[src="${secondAddress}"]`)).toBeVisible();
    await save(page);
    expect((await signerOf())?.assetId).toBe(replaced.id);
    // The replaced image is superseded, never removed: whatever was issued with it still draws it.
    const kept = await page.request.get(firstAddress);
    expect(kept.status()).toBe(200);
    expect(Buffer.compare(await kept.body(), firstBytes)).toBe(0);

    // The same file again is the image already registered: no new row.
    const again = await uploadThroughTile(page, signerName, second);
    expect(again.id).toBe(replaced.id);
    const registered = await db.query(
      'select id from public.document_assets where owner_id=$1 order by created_at',
      [owner],
    );
    expect(registered.rows.map((row: { id: string }) => row.id)).toEqual([
      uploaded.id,
      replaced.id,
    ]);

    // A reload reads the commission from the server again.
    await openCommon(page);
    await expect(page.locator(`img[src="${secondAddress}"]`)).toBeVisible();

    const issuedAfter = await issuedMetadata(page, certificateId);
    expect(issuedAfter.branding).toEqual(issuedBefore.branding);
    expect(issuedAfter.certificateNumber).toBe(issuedBefore.certificateNumber);

    // The member leaves the commission again.
    await page
      .getByRole('button', { name: `Убрать из комиссии: ${signerName}`, exact: true })
      .click();
    await save(page);
    expect(await signerOf()).toBeUndefined();
  } finally {
    // The images stay registered, as every registered image does: a document
    // being drawn in a parallel test may still ask for them.
    await db.end();
  }
});
