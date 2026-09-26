import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('retired password-recovery endpoints are removed, so nothing can parse or verify a recovery credential', async () => {
  for (const route of [
    'app/api/auth/password/recovery/route.ts',
    'app/api/auth/password/recovery/verify/route.ts',
    'app/api/auth/password/context/route.ts',
    'app/api/auth/password/route.ts',
  ]) {
    await assert.rejects(read(route), { code: 'ENOENT' }, route);
  }
});
