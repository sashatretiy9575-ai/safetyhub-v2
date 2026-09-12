import { expect, test, type Page } from '@playwright/test';

// A wide sweep of every public and sign-in route at the phone, tablet and
// desktop widths the owner cares about, including a 320 px phone and the
// iPhone 12/13 mini. It is slow, so it runs only when asked:
//   E2E_SWEEP=1 npx playwright test e2e/responsive-sweep.spec.ts
// The account and admin routes need the release runner's sessions
// (E2E_ADMIN_STORAGE_STATE / E2E_PARTICIPANT_STORAGE_STATE) and are swept by
// scripts/run-e2e-release.mjs.
const enabled = process.env.E2E_SWEEP === '1';

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
] as const;

const PUBLIC_ROUTES = [
  '/',
  '/topics',
  '/blog',
  '/contacts',
  '/faq',
  '/privacy',
  '/terms',
  '/verify/bad-token',
  '/this-page-does-not-exist',
  '/auth/login',
  '/kk',
  '/kk/topics',
  '/kk/auth/login',
  '/en',
  '/en/blog',
  '/en/auth/login',
  '/zh/auth/login',
  '/offline/ru',
  '/offline/kk',
  '/offline/en',
  '/offline/zh',
] as const;

// Safe-area insets of an iPhone with a home indicator, so the fixed dock is
// measured where iOS actually draws it.
const SAFE_AREA_STYLE = ':root{--safe-area-bottom:34px;--safe-area-top:47px}';

async function blockRemoteIntegrations(page: Page) {
  await page.route('https://*.supabase.co/**', (route) => route.abort());
  await page.route('https://challenges.cloudflare.com/**', (route) => route.abort());
}

type Geometry = {
  clientWidth: number;
  scrollWidth: number;
  overflowing: string[];
  smallestFont: number;
  dockGap: number | null;
  mainBottomPadding: number | null;
};

function measure(): Geometry {
  const root = document.documentElement;
  const width = window.innerWidth;
  const overflowing: string[] = [];
  const skip = (element: Element) =>
    element.closest('.sr-only, [data-marketing-carousel-controls], [role="list"][tabindex]') !==
      null ||
    element.closest('.overflow-x-auto, [style*="overflow-x"]') !== null ||
    element.closest('.snap-x') !== null;
  let smallestFont = Number.POSITIVE_INFINITY;
  for (const element of Array.from(document.body.querySelectorAll('*'))) {
    if (!(element instanceof HTMLElement)) continue;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (element.textContent?.trim() && element.children.length === 0) {
      const size = Number.parseFloat(style.fontSize);
      if (Number.isFinite(size)) smallestFont = Math.min(smallestFont, size);
    }
    if (rect.right > width + 1 && !skip(element)) {
      overflowing.push(
        `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}.${String(element.className).split(' ').slice(0, 3).join('.')}`,
      );
    }
  }
  const dock = document.querySelector('nav.fixed, nav[class*="fixed"]');
  let dockGap: number | null = null;
  if (dock instanceof HTMLElement && getComputedStyle(dock).display !== 'none') {
    dockGap = window.innerHeight - dock.getBoundingClientRect().bottom;
  }
  const main = document.querySelector('main');
  const mainBottomPadding = main
    ? Number.parseFloat(getComputedStyle(main).paddingBottom) +
      Number.parseFloat(getComputedStyle(document.body).paddingBottom)
    : null;
  return {
    clientWidth: root.clientWidth,
    scrollWidth: root.scrollWidth,
    overflowing: overflowing.slice(0, 8),
    smallestFont,
    dockGap,
    mainBottomPadding,
  };
}

test.describe('responsive sweep', () => {
  test.skip(!enabled, 'Set E2E_SWEEP=1 to run the responsive sweep.');

  for (const viewport of VIEWPORTS) {
    for (const route of PUBLIC_ROUTES) {
      test(`${route} at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await blockRemoteIntegrations(page);
        const errors: string[] = [];
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setViewportSize(viewport);
        await page.addStyleTag({ content: SAFE_AREA_STYLE }).catch(() => undefined);
        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        expect(response, route).toBeTruthy();
        await page.addStyleTag({ content: SAFE_AREA_STYLE });
        await expect(page.locator('body')).toBeVisible();
        await page.waitForTimeout(250);

        const geometry = await page.evaluate(measure);
        expect(geometry.scrollWidth, `${route} scrolls horizontally`).toBeLessThanOrEqual(
          geometry.clientWidth,
        );
        expect(geometry.overflowing, `${route} has elements outside the viewport`).toEqual([]);
        const floor = route.startsWith('/zh') || route.endsWith('/zh') ? 12 : 11;
        expect(
          geometry.smallestFont,
          `${route} renders text below ${floor}px`,
        ).toBeGreaterThanOrEqual(floor - 0.01);
        if (viewport.width < 1024 && geometry.dockGap !== null) {
          // The dock sits on the safe-area inset: its bottom edge is the inset
          // above the physical bottom, never under the home indicator.
          expect(geometry.dockGap, `${route} dock overlaps the home indicator`).toBeGreaterThanOrEqual(
            33,
          );
        }
        expect(
          errors.filter((entry) => !/supabase|challenges\.cloudflare|net::ERR_FAILED/u.test(entry)),
          `${route} logged console errors`,
        ).toEqual([]);
      });
    }
  }
});
