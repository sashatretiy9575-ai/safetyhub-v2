import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('retired password-recovery endpoints never parse, verify, or persist recovery credentials', async () => {
  const routes = await Promise.all(
    [
      'app/api/auth/password/recovery/route.ts',
      'app/api/auth/password/recovery/verify/route.ts',
      'app/api/auth/password/context/route.ts',
      'app/api/auth/password/route.ts',
    ].map(read),
  );

  for (const source of routes) {
    assert.match(source, /passwordAuthRetiredResponse\(\)/u);
    assert.doesNotMatch(
      source,
      /readJsonBody|verifyOtp|resetPasswordForEmail|setSession|updateUser|PasswordContext|accessToken|refreshToken/u,
    );
  }
});
