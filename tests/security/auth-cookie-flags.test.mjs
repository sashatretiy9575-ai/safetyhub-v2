import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { NextResponse } from 'next/server.js';
import { supabaseAuthCookieOptions } from '../../lib/supabase/auth-cookie-options.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('server and middleware share one HttpOnly Supabase cookie policy', async () => {
  const [server, middleware, policy] = await Promise.all([
    read('lib/supabase/server.ts'),
    read('lib/supabase/middleware.ts'),
    read('lib/supabase/auth-cookie-options.ts'),
  ]);
  for (const source of [server, middleware]) {
    assert.match(source, /cookieOptions: supabaseAuthCookieOptions\(\)/);
  }
  assert.match(policy, /httpOnly: true/);
  assert.match(policy, /sameSite: 'lax'/);
  assert.match(policy, /path: '\/'/);
  assert.doesNotMatch(policy, /\bname:/);
  assert.match(middleware, /setAll\(cookiesToSet, responseHeaders\)/);
  assert.match(middleware, /Object\.entries\(responseHeaders\)/);
});

test('production Set-Cookie is HttpOnly, Secure, SameSite=Lax and root-scoped', () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    'sb-project-auth-token.0',
    'opaque-session-chunk',
    supabaseAuthCookieOptions({ NODE_ENV: 'production' }),
  );
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header, /HttpOnly/i);
  assert.match(header, /Secure/i);
  assert.match(header, /SameSite=Lax/i);
  assert.match(header, /Path=\//i);
});

test('local HTTP keeps every protection except Secure', () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    'sb-project-auth-token',
    'opaque-session',
    supabaseAuthCookieOptions({ NODE_ENV: 'development' }),
  );
  const header = response.headers.get('set-cookie') ?? '';
  assert.match(header, /HttpOnly/i);
  assert.doesNotMatch(header, /; Secure/i);
});
