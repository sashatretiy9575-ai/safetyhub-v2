import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Turnstile remains completely dormant until a protected submit', async () => {
  const source = await read('features/auth/turnstile.tsx');

  assert.match(source, /const \[activated, setActivated\] = useState\(false\)/u);
  assert.match(source, /setActivated\(true\)/u);
  assert.match(source, /if \(!siteKey \|\| !activated\) return null/u);
  assert.match(source, /if \(!siteKey \|\| !activated\) return;/u);
  assert.doesNotMatch(source, /pointerdown|focusin|keydown/u);
  assert.doesNotMatch(source, /strategy="beforeInteractive"/u);
});

test('Turnstile uses one deferred native Cloudflare widget', async () => {
  const source = await read('features/auth/turnstile.tsx');

  assert.match(source, /const TURNSTILE_SCRIPT_ID = 'cloudflare-turnstile-api'/u);
  assert.match(source, /id=\{TURNSTILE_SCRIPT_ID\}/u);
  assert.match(source, /execution: 'execute'/u);
  assert.match(source, /appearance: 'always'/u);
  assert.match(source, /language: 'ru'/u);
  assert.match(source, /retry: 'never'/u);
  assert.match(source, /'refresh-expired': 'manual'/u);
  assert.match(source, /'refresh-timeout': 'manual'/u);
  assert.match(source, /window\.turnstile\.execute\(widgetId\)/u);
  assert.match(
    source,
    /if \(!siteKey \|\| pendingExecutionRef\.current \|\| completedRef\.current\) return/u,
  );
  assert.equal(source.match(/<Script/gu)?.length, 1);
  assert.doesNotMatch(source, /Проверка пройдена|ShieldCheck|role="checkbox"/u);
});

test('Turnstile failures invalidate the token and a retry executes the native widget', async () => {
  const source = await read('features/auth/turnstile.tsx');
  const failureHandler = source.slice(
    source.indexOf('const failVerification'),
    source.indexOf('const executeNativeWidget'),
  );

  assert.match(failureHandler, /pendingExecutionRef\.current = false/u);
  assert.match(failureHandler, /onTokenRef\.current\(null\)/u);
  assert.match(source, /onClick=\{execute\}/u);
  assert.match(source, /window\.turnstile\.remove\(widgetRef\.current\)/u);
  assert.doesNotMatch(source, /console\./u);
});

test('auth callers defer one pending submit and continue it once after token delivery', async () => {
  const callers = await Promise.all([
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
    read('features/auth/password-recovery-flow.tsx'),
    read('features/auth/password-change-form.tsx'),
  ]);

  for (const source of callers) {
    assert.match(source, /useRef<TurnstileHandle>\(null\)/u);
    assert.match(
      source,
      /pendingCaptchaSubmitRef\.current = \(token\) => void (?:submitRequest|sendCode)\([^;]+\)/u,
    );
    assert.match(source, /turnstileRef\.current\?\.execute\(\)/u);
    assert.match(
      source,
      /const pending = pendingCaptchaSubmitRef\.current;[\s\S]*pendingCaptchaSubmitRef\.current = null;[\s\S]*pending\?\.\(token\)/u,
    );
    assert.match(source, /<Turnstile[\s\S]*?key=\{captchaVersion\}[\s\S]*?ref=\{turnstileRef\}/u);
    assert.doesNotMatch(source, /onPointerDown|onFocus|onKeyDown/u);
  }
});
