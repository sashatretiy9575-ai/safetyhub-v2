import { expect, test, type Locator, type Page } from '@playwright/test';
import { resetLocalDocumentSettingsQuota } from './helpers/local-document-settings-quota';

test.use({ storageState: process.env.E2E_ADMIN_STORAGE_STATE, channel: 'chrome' });

// Every replacement is one unit of the administrator's settings budget. Each
// scenario/retry starts with a full one; the product limit itself is untouched.
test.beforeEach(async ({ page }, testInfo) => {
  await resetLocalDocumentSettingsQuota(page.request, String(testInfo.project.use.baseURL));
});

// A click that lands before React hydrates is lost, and on a CI runner that window is seconds wide.
async function openEditor(page: Page, url?: string) {
  if (url) await page.goto(url);
  else await page.reload();
  await expect(page.locator('.document-editor[data-hydrated]')).toBeVisible();
}

type Replacement = {
  asset: { id: string; ownerId: string; kind: string };
  profiles: { id: string; commission: { signerId: string; assetId: string | null }[] }[];
  changed: number;
};

/** Picks a file through the tile's own button and returns what the route answered. */
async function replaceThroughTile(
  page: Page,
  tile: Locator,
  button: 'Загрузить' | 'Заменить',
  buffer: Buffer,
): Promise<Replacement> {
  const chooser = page.waitForEvent('filechooser');
  const answered = page.waitForResponse(
    (response) =>
      response.url().includes('/api/admin/documents/assets') &&
      response.request().method() === 'PUT',
  );
  await tile.getByRole('button', { name: button, exact: true }).click();
  await (await chooser).setFiles({ name: 'signature.png', mimeType: 'image/png', buffer });
  const response = await answered;
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
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

test('a replaced signature gets an address of its own and leaves issued documents as they were', async ({
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
  const { createClient } = await import('@supabase/supabase-js');
  const { createRequire } = await import('node:module');
  const pg = createRequire(import.meta.url)('pg');
  const sharp = (await import('sharp')).default;

  // Nothing real is touched: a signer nobody else has, seated in a profile of a
  // program that does not exist. The registry lists every profile's signers, so
  // the tile is there whichever programs the stand has.
  const token = randomUUID();
  const owner = 'e2e-' + token;
  const profileId = 'e2e-registry-' + token;
  const signerName = 'Тестовый подписант ' + token.slice(0, 8);
  const title = signerName + ' — подпись';
  // A labelled geometric fixture, never an actual person's signature or a private source
  // file. The bars spell the token, so no two runs ever register the same bytes.
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
  const body = {
    id: profileId,
    courseSlug: profileId,
    audience: 'all',
    label: 'Реестр подписей — тест',
    programName: 'Реестр подписей — тест',
    family: 'general',
    hours: null,
    validityMonths: 0,
    protocolText: 'Тестовая программа {program}.',
    decisionText: 'Тестовый профиль.',
    orderNumber: '',
    orderDate: '',
    verificationKind: '',
    commission: [
      { signerId: owner, name: signerName, position: 'Тестовая комиссия', assetId: null },
    ],
    stampAssetId: null,
  };
  const client = createClient(url, process.env.SUPABASE_SECRET_KEY!, {
    auth: { persistSession: false },
  });
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    await db.query(
      'insert into public.document_profiles(id,course_slug,audience,body) values($1,$2,$3,$4)',
      [profileId, profileId, 'all', body],
    );

    // An issued document to hold the replacement against: its snapshot names the
    // images it was issued with and must not notice anything that happens below.
    const initial = await (await page.request.get('/api/admin/documents')).json();
    let certificateId: string | null = null;
    for (const organization of initial.organizations) {
      for (const course of initial.courses) {
        const company = await (
          await page.request.get('/api/admin/documents', {
            params: { organization, course: course.slug },
          })
        ).json();
        certificateId =
          company.participants?.find((p: { certificateId: string | null }) => p.certificateId)
            ?.certificateId ?? null;
        if (certificateId) break;
      }
      if (certificateId) break;
    }
    expect(certificateId, 'seeded company must include an issued certificate').not.toBeNull();
    const issuedBefore = await issuedMetadata(page, certificateId!);

    await openEditor(page, '/admin/settings/certificate');
    const section = page.getByRole('button', { name: /^Подписи и печать/ });
    // Closed, the section already says whose picture is missing.
    await expect(section).toContainText('Нет:');
    await expect(section).toContainText(title);
    await section.click();
    // One section, one kind of tile: the settings' own stamp is not offered beside the registry.
    await expect(page.getByRole('button', { name: /^Печать: / })).toHaveCount(0);
    // A tile is a group named by whose picture it holds.
    const tile = page.getByRole('group', { name: title, exact: true });
    await expect(tile).toBeVisible();
    // The viewer keeps a second copy of the picture inside its closed dialog; the sheet is the one in sight.
    const sheet = tile
      .locator('img[src*="/certificate-assets/registered?id="]')
      .filter({ visible: true });
    await expect(sheet).toHaveCount(0);

    const uploaded = await replaceThroughTile(page, tile, 'Загрузить', first);
    expect(uploaded.asset).toMatchObject({ ownerId: owner, kind: 'signature' });
    expect(uploaded.changed).toBe(1);
    const firstAddress = '/certificate-assets/registered?id=' + uploaded.asset.id;
    await expect(tile.getByText('Заменено — для новых выдач', { exact: true })).toBeVisible();
    await expect(sheet).toHaveAttribute('src', firstAddress);
    await expect(section).not.toContainText(title);
    const firstServed = await page.request.get(firstAddress);
    expect(firstServed.status()).toBe(200);
    expect(firstServed.headers()['content-type']).toBe('image/png');
    const firstBytes = await firstServed.body();

    // Another picture is another image with another address: nothing the browser
    // kept under the old one can be shown in its place.
    const replaced = await replaceThroughTile(page, tile, 'Заменить', second);
    expect(replaced.changed).toBe(1);
    expect(replaced.asset.id).not.toBe(uploaded.asset.id);
    const secondAddress = '/certificate-assets/registered?id=' + replaced.asset.id;
    await expect(sheet).toHaveAttribute('src', secondAddress);
    expect(
      replaced.profiles.find((profile) => profile.id === profileId)?.commission[0]?.assetId,
    ).toBe(replaced.asset.id);
    const secondServed = await page.request.get(secondAddress);
    expect(secondServed.status()).toBe(200);
    expect(Buffer.compare(await secondServed.body(), firstBytes)).not.toBe(0);

    // The replaced image is superseded, never removed: whatever was issued with it still draws it.
    const kept = await page.request.get(firstAddress);
    expect(kept.status()).toBe(200);
    expect(kept.headers()['content-type']).toBe('image/png');
    expect(Buffer.compare(await kept.body(), firstBytes)).toBe(0);

    // The same file again is the image already in place: no new row, no profile rewritten.
    const again = await replaceThroughTile(page, tile, 'Заменить', second);
    expect(again.changed).toBe(0);
    expect(again.asset.id).toBe(replaced.asset.id);
    await expect(tile.getByText('Это изображение уже стоит', { exact: true })).toBeVisible();
    await expect(sheet).toHaveAttribute('src', secondAddress);
    const stored = await db.query(
      'select body, version from public.document_profiles where id=$1',
      [profileId],
    );
    expect(stored.rows[0].body.commission[0].assetId).toBe(replaced.asset.id);
    // Created at 1, bound twice; the third upload changed nothing.
    expect(Number(stored.rows[0].version)).toBe(3);
    const registered = await db.query(
      'select id from public.document_assets where owner_id=$1 order by created_at',
      [owner],
    );
    expect(registered.rows.map((row: { id: string }) => row.id)).toEqual([
      uploaded.asset.id,
      replaced.asset.id,
    ]);

    // A reload reads whose the image is from the server again: the tile still shows it.
    await openEditor(page);
    await expect(sheet).toHaveAttribute('src', secondAddress);

    const issuedAfter = await issuedMetadata(page, certificateId!);
    expect(issuedAfter.branding).toEqual(issuedBefore.branding);
    expect(issuedAfter.certificateNumber).toBe(issuedBefore.certificateNumber);
    expect(issuedAfter.issuedAt).toBe(issuedBefore.issuedAt);
  } finally {
    try {
      const assets = await db.query(
        'select object_key from public.document_assets where owner_id=$1',
        [owner],
      );
      const cleaned = await db.query(
        'delete from public.document_profiles where id=$1 and course_slug=$1',
        [profileId],
      );
      expect(cleaned.rowCount, 'only the fixture profile may be removed').toBeLessThanOrEqual(1);
      await db.query('delete from public.document_assets where owner_id=$1', [owner]);
      if (assets.rows.length) {
        const removed = await client.storage
          .from('document-facsimiles')
          .remove(assets.rows.map((row: { object_key: string }) => row.object_key));
        expect(removed.error).toBeNull();
      }
    } finally {
      await db.end();
    }
  }
});
