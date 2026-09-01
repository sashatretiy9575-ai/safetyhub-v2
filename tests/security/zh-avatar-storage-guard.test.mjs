import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const MIGRATION = 'supabase/migrations/20260901109100_zh_avatar_storage_write_guard.sql';

test('ZH avatar writes require the exact live server-only registration operation', async () => {
  const [migration, sqlContract, loadHarness] = await Promise.all([
    readFile(MIGRATION, 'utf8'),
    readFile('supabase/tests/zh_avatar_storage_guard.sql', 'utf8'),
    readFile('scripts/load-test-supabase.mjs', 'utf8'),
  ]);

  assert.match(
    migration,
    /create or replace function private\.guard_profile_avatar_storage_write/u,
  );
  assert.match(migration, /tg_op = 'INSERT'[\s\S]*auth\.role\(\)[\s\S]*= 'service_role'/u);
  assert.match(
    migration,
    /private\.zh_registration_operations[\s\S]*operation_id = v_object_operation_id[\s\S]*for share/u,
  );
  assert.match(
    migration,
    /auth_user_id = v_user_id[\s\S]*state = 'auth_created'[\s\S]*avatar_object_key is null/u,
  );
  assert.match(
    migration,
    /private\.zh_webauthn_challenges[\s\S]*purpose = 'registration'[\s\S]*consumed_at is null[\s\S]*expires_at > clock_timestamp\(\)/u,
  );
  assert.match(migration, /safetyhub_registration_operation_id/u);
  assert.match(
    migration,
    /revoke all on function private\.guard_profile_avatar_storage_write\(\)[\s\S]*service_role/u,
  );

  assert.match(sqlContract, /authenticated role used the server-only ZH avatar write path/u);
  assert.match(sqlContract, /service role wrote an avatar without an exact ZH operation/u);
  assert.match(sqlContract, /storage_written ZH operation replayed its avatar write/u);
  assert.match(sqlContract, /expired ZH registration challenge authorized an avatar write/u);

  assert.match(loadHarness, /\.storage\.from\('profile-avatars'\)\.upload/u);
  assert.doesNotMatch(loadHarness, /insert into storage\.objects/iu);
});
