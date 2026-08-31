import { expect, test } from '@playwright/test';

test('auth HTML carries a unique strict CSP and baseline hardening headers', async ({ page }) => {
  const first = await page.goto('/auth/login');
  expect(first?.ok()).toBeTruthy();
  const firstHeaders = first?.headers() ?? {};
  const firstCsp = firstHeaders['content-security-policy'] ?? '';

  expect(firstCsp).toContain("'strict-dynamic'");
  expect(firstCsp).toContain('https://challenges.cloudflare.com');
  expect(firstCsp).toContain("frame-ancestors 'none'");
  expect(firstCsp).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(firstHeaders['x-content-type-options']).toBe('nosniff');
  expect(firstHeaders['referrer-policy']).toBe('no-referrer');
  expect(firstHeaders['x-frame-options']).toBe('DENY');
  expect(firstHeaders['permissions-policy']).toContain('camera=()');
  expect(firstHeaders['cross-origin-opener-policy']).toBe('same-origin');
  expect(firstHeaders['cross-origin-resource-policy']).toBe('same-origin');
  expect(firstHeaders['origin-agent-cluster']).toBe('?1');
  expect(firstHeaders['x-robots-tag']).toContain('noindex');
  expect(firstHeaders['x-powered-by']).toBeUndefined();

  const firstNonce = firstCsp.match(/'nonce-([^']+)'/u)?.[1];
  expect(firstNonce).toMatch(/^[A-Za-z0-9+/_-]{16,128}={0,2}$/u);

  const second = await page.reload();
  const secondNonce = (second?.headers()['content-security-policy'] ?? '').match(
    /'nonce-([^']+)'/u,
  )?.[1];
  expect(secondNonce).toBeTruthy();
  expect(secondNonce).not.toBe(firstNonce);
});

test('public HTML keeps the cacheable static policy', async ({ request }) => {
  const response = await request.get('/blog', {
    headers: { cookie: 'sb-attacker-auth-token=fake' },
  });
  expect(response.ok()).toBeTruthy();
  const csp = response.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self' 'unsafe-inline'");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp).not.toContain('https://*.supabase.co');
  expect(csp).not.toContain("'nonce-");
});

test('API responses are explicitly excluded from browser and CDN caches', async ({ request }) => {
  const response = await request.post('/api/profile', {
    headers: { origin: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3100' },
    data: {},
  });
  expect([400, 401, 403]).toContain(response.status());
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['cdn-cache-control']).toBe('no-store');
  expect(response.headers()['vercel-cdn-cache-control']).toBe('no-store');
});

test('the selected theme survives navigation into nonce-protected auth pages', async ({ page }) => {
  const cspErrors: string[] = [];
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /content security policy|refused to execute inline script/iu.test(message.text())
    ) {
      cspErrors.push(message.text());
    }
  });

  await page.goto('/');
  const themeSwitch = page.getByRole('switch');
  const currentAction = await themeSwitch.getAttribute('aria-label');
  if (currentAction?.includes('тёмную')) await themeSwitch.click();

  await expect(page.locator('html')).toHaveClass(/dark/u);
  await page.goto('/auth/login');
  await expect(page.locator('html')).toHaveClass(/dark/u);
  await expect(page.getByRole('switch')).toHaveAttribute(
    'aria-label',
    'Тёмная тема. Переключить на светлую',
  );
  expect(cspErrors).toEqual([]);
});
