import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(repositoryRoot, relativePath), 'utf8');

test('legacy password callback links cannot create, confirm, or recover an account', async () => {
  const callback = await read('app/(account)/callback/route.ts');

  assert.doesNotMatch(
    callback,
    /exchangeCodeForSession|signupLegalCorrelationFromUserMetadata|finalizeSignupLegalOperation/u,
  );
});

test('the canonical browser access page owns the neutral email OTP flow', async () => {
  const [login, register] = await Promise.all([
    read('app/(account)/auth/login/page.tsx'),
    read('app/(account)/auth/register/page.tsx'),
  ]);

  assert.match(login, /<EmailOtpFlow \/>/u);
  assert.doesNotMatch(
    login,
    /intent=|PasswordInput|type="password"|clientRequest\('\/api\/auth\/login'/u,
  );
  assert.match(register, /redirect\(localizePathname\('\/auth\/login', locale\)\)/u);
  assert.doesNotMatch(
    register,
    /<EmailOtpFlow|intent=|PasswordInput|type="password"|clientRequest\('\/api\/auth\/register'/u,
  );
});
