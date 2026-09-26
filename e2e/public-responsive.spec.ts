import { expect, test, type Page } from '@playwright/test';

const viewports = [
  { width: 240, height: 320 },
  { width: 320, height: 240 },
  { width: 280, height: 653 },
  { width: 653, height: 280 },
  { width: 320, height: 568 },
  { width: 568, height: 320 },
  { width: 360, height: 800 },
  { width: 390, height: 844 },
  { width: 800, height: 360 },
  { width: 844, height: 390 },
  { width: 768, height: 1024 },
  { width: 820, height: 1180 },
  { width: 1024, height: 1366 },
  { width: 1023, height: 900 },
  { width: 1024, height: 900 },
  { width: 1119, height: 900 },
  { width: 1120, height: 900 },
  { width: 1199, height: 900 },
  { width: 1200, height: 900 },
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
] as const;

async function blockRemoteIntegrations(page: Page) {
  await page.route('https://*.supabase.co/**', (route) => route.abort());
}

async function waitForHydration(page: Page) {
  await expect(page.locator('html')).toHaveAttribute('data-hydrated', 'true');
}

for (const viewport of viewports) {
  test(`public shell is usable without horizontal overflow at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await blockRemoteIntegrations(page);
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('pageerror', (error) => errors.push(error.message));

    await page.setViewportSize(viewport);
    const response = await page.goto('/blog', { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBeTruthy();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(errors).toEqual([]);
  });
}

test('courses are a grid, two a row on a phone, and never a slider', async ({ page }) => {
  await blockRemoteIntegrations(page);
  await page.goto('/topics', { waitUntil: 'domcontentloaded' });
  const catalogCards = page.locator('[data-course-card]');
  await expect(catalogCards.first()).toBeVisible();
  const publishedLinks = await catalogCards.evaluateAll((cards) =>
    cards.map((card) => card.getAttribute('href')).sort(),
  );
  // Geometry needs five cards; the published catalog may grow beyond the seed.
  expect(publishedLinks.length).toBeGreaterThanOrEqual(5);
  expect(new Set(publishedLinks).size).toBe(publishedLinks.length);

  // Cards a row: one below 360px, two on a phone, three from 768px, four from 1280px.
  for (const [width, perRow] of [
    [320, 1],
    [390, 2],
    [768, 3],
    [1280, 4],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    for (const address of ['/', '/topics']) {
      await page.goto(address, { waitUntil: 'domcontentloaded' });
      const cards = page.locator(
        address === '/' ? '#courses [data-course-card]' : '[data-course-card]',
      );
      expect(
        await cards.evaluateAll((nodes) => nodes.map((card) => card.getAttribute('href')).sort()),
      ).toEqual(publishedLinks);
      await cards.first().scrollIntoViewIfNeeded();
      // Measured once the grid has settled: right after a resize and a load
      // the first look can land before the stylesheet has laid the grid out.
      const firstRowWidths = () =>
        cards.evaluateAll((nodes) => {
          const boxes = nodes.map((card) => card.getBoundingClientRect());
          const top = boxes[0]?.top ?? 0;
          return boxes.filter((box) => Math.abs(box.top - top) <= 1).map((box) => box.width);
        });
      await expect
        .poll(async () => (await firstRowWidths()).length, { message: `${address} at ${width}px` })
        .toBe(perRow);
      const widths = await firstRowWidths();
      expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
      await expect(
        page
          .locator(address === '/' ? '#courses' : 'main')
          .getByRole('button', { name: /Следующая/ }),
      ).toHaveCount(0);
      const geometry = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      }));
      expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    }
  }
});

test('hero uses mobile and desktop artwork without autoplay controls', async ({ page }) => {
  await blockRemoteIntegrations(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const heroImage = page.getByAltText(
    'Специалисты по безопасности проверяют данные на производстве',
  );
  await expect(heroImage).toBeVisible();
  expect(await heroImage.evaluate((image: HTMLImageElement) => image.currentSrc)).toContain(
    'hero-safetyhub-mobile-v2.webp',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await heroImage.evaluate((image: HTMLImageElement) => image.currentSrc)).toContain(
    'hero-safetyhub-desktop-v2.webp',
  );
  await expect(page.getByRole('button', { name: /приостановить|возобновить/i })).toHaveCount(0);
});

// The shell now switches at 1024px, the same width at which the admin sidebar
// appears. The old 1120px threshold left 1024-1119px showing the floating mobile
// dock in the middle of a laptop screen; this test still asserted the old value.
test('app shell hands off to desktop navigation exactly at 1024px', async ({ page }) => {
  await blockRemoteIntegrations(page);
  await page.setViewportSize({ width: 1023, height: 900 });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeVisible();

  await page.setViewportSize({ width: 1024, height: 900 });
  await expect(page.getByRole('navigation', { name: 'Основная навигация' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Основные разделы' })).toBeHidden();
});

test('contact actions stay compact, left-aligned, and unclipped on a narrow phone', async ({
  page,
}) => {
  await blockRemoteIntegrations(page);
  await page.setViewportSize({ width: 320, height: 760 });
  await page.goto('/contacts', { waitUntil: 'domcontentloaded' });

  const call = page.getByRole('link', { name: /^Позвонить\s/u }).first();
  const whatsapp = page.getByRole('link', { name: 'Написать в WhatsApp' }).first();
  const [callBox, whatsappBox] = await Promise.all([call.boundingBox(), whatsapp.boundingBox()]);
  expect(callBox && whatsappBox).toBeTruthy();
  if (!callBox || !whatsappBox) return;

  expect(whatsappBox.y).toBeGreaterThan(callBox.y);
  expect(Math.abs(callBox.x - whatsappBox.x)).toBeLessThanOrEqual(1);
  expect(callBox.x).toBeGreaterThanOrEqual(0);
  expect(callBox.x + callBox.width).toBeLessThanOrEqual(320);
  expect(whatsappBox.x + whatsappBox.width).toBeLessThanOrEqual(320);
  expect(callBox.height).toBeLessThanOrEqual(64);
  expect(whatsappBox.height).toBeLessThanOrEqual(64);
});

test('guest is redirected from protected pages without seeing account content', async ({
  page,
}) => {
  await page.goto('/profile');
  await expect(page).toHaveURL(/\/auth\/login\?return=%2Fprofile/u);
  await expect(page.getByRole('heading', { name: /вход/iu })).toBeVisible();
});

test('article hero, table of contents and body share the 1120px desktop rail', async ({ page }) => {
  await blockRemoteIntegrations(page);
  for (const width of [1440, 1536, 1920] as const) {
    await page.setViewportSize({ width, height: 1080 });
    await page.goto('/blog/ohrana-truda-kazakhstan-2026', { waitUntil: 'domcontentloaded' });

    const hero = page.locator('[data-article-region="hero"]');
    const toc = page.locator('[data-article-region="toc"]');
    const body = page.locator('[data-article-region="body"]');
    await Promise.all([
      expect(hero).toBeVisible(),
      expect(toc).toBeVisible(),
      expect(body).toBeVisible(),
    ]);
    const boxes = await Promise.all([hero.boundingBox(), toc.boundingBox(), body.boundingBox()]);
    expect(boxes.every(Boolean)).toBe(true);
    const widths = boxes.map((box) => box?.width ?? 0);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
    expect(Math.abs((widths[0] ?? 0) - 1120)).toBeLessThanOrEqual(2);
  }
});

test('a course card keeps its 16:9 cover at every width', async ({ page }) => {
  await blockRemoteIntegrations(page);
  for (const width of [320, 390, 1280] as const) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/topics', { waitUntil: 'domcontentloaded' });

    const card = page.locator('[data-course-card]').first();
    await expect(card).toBeVisible();
    const cover = await card.locator('[data-course-card-cover]').boundingBox();
    expect(cover).toBeTruthy();
    expect(Math.abs((cover?.width ?? 0) * (9 / 16) - (cover?.height ?? 0))).toBeLessThanOrEqual(2);
  }
});

test('course CTA uses a full second row without clipping across the viewport matrix', async ({
  page,
}) => {
  await blockRemoteIntegrations(page);
  await page.setViewportSize({ width: 240, height: 900 });
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' });
  expect(response?.ok()).toBeTruthy();

  const card = page.locator('[data-course-card]').first();
  await expect(card).toBeVisible();
  const actions = card.locator('[data-course-card-actions]');
  const controls = actions.locator(':scope > span');
  await expect(controls).toHaveCount(3);

  for (const width of [240, 280, 320, 360, 390, 600, 768, 1200] as const) {
    await page.setViewportSize({ width, height: 900 });
    // A phone card is half the screen: the two chips give way to the action.
    if (width >= 640) {
      const boxes = await Promise.all([0, 1, 2].map((index) => controls.nth(index).boundingBox()));
      expect(boxes.every(Boolean)).toBe(true);
      expect(Math.abs((boxes[0]?.y ?? 0) - (boxes[1]?.y ?? 0))).toBeLessThanOrEqual(1);
      expect(boxes[2]?.y ?? 0).toBeGreaterThan((boxes[0]?.y ?? 0) + 1);
    } else {
      await expect(controls.nth(0)).toBeHidden();
      await expect(controls.nth(1)).toBeHidden();
    }

    const cta = card.locator('[data-course-card-cta]');
    await expect(cta).toContainText('Открыть курс');
    const ctaGeometry = await cta.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      height: element.getBoundingClientRect().height,
    }));
    expect(ctaGeometry.scrollWidth).toBeLessThanOrEqual(ctaGeometry.clientWidth);
    expect(ctaGeometry.height).toBeGreaterThanOrEqual(44);

    const pageGeometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(pageGeometry.scrollWidth).toBeLessThanOrEqual(pageGeometry.clientWidth);
  }
});

test('240px course catalog and compact labels never overflow horizontally', async ({ page }) => {
  await blockRemoteIntegrations(page);
  await page.setViewportSize({ width: 240, height: 653 });
  await page.goto('/topics', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-course-card]').first()).toBeVisible();
  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test('theme switch synchronizes metadata, color scheme and document backgrounds', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('theme', 'light'));
  await blockRemoteIntegrations(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForHydration(page);

  const themeState = () =>
    page.evaluate(() => ({
      dark: document.documentElement.classList.contains('dark'),
      colorScheme: document.documentElement.style.colorScheme,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      themeColor: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content,
    }));

  await expect.poll(themeState).toEqual({
    dark: false,
    colorScheme: 'light',
    htmlBackground: 'rgb(247, 248, 250)',
    bodyBackground: 'rgb(247, 248, 250)',
    themeColor: '#f7f8fa',
  });
  await page.getByRole('switch', { name: 'Тёмная тема', checked: false }).click();
  await expect.poll(themeState).toEqual({
    dark: true,
    colorScheme: 'dark',
    htmlBackground: 'rgb(13, 15, 18)',
    bodyBackground: 'rgb(13, 15, 18)',
    themeColor: '#0d0f12',
  });
});
