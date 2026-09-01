import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationPath = 'supabase/migrations/20260901109200_runtime_trigger_flag_boundary.sql';
const sqlTestPath = 'supabase/tests/runtime_trigger_flag_boundary.sql';

test('runtime flags stay private and are evaluated inside trigger definers', async () => {
  const [migration, sqlTest] = await Promise.all([
    readFile(migrationPath, 'utf8'),
    readFile(sqlTestPath, 'utf8'),
  ]);

  for (const functionName of [
    'emit_approval_requested_notification',
    'emit_course_completed_notification',
    'request_notification_dispatch_after_insert',
  ]) {
    assert.match(
      migration,
      new RegExp(
        `create or replace function private\\.${functionName}\\(\\)[\\s\\S]*?security definer[\\s\\S]*?runtime_feature_enabled`,
      ),
    );
  }

  assert.doesNotMatch(migration, /for each row\s+when\s*\(/iu);
  assert.match(
    migration,
    /revoke all on function private\.runtime_feature_enabled\(text\)[\s\S]*?from public, anon, authenticated, service_role/iu,
  );
  assert.match(
    sqlTest,
    /foreach v_role in array array\['anon'::name, 'authenticated'::name, 'service_role'::name\]/u,
  );
  assert.match(sqlTest, /set local role service_role;[\s\S]*?update public\.account_controls/iu);
  assert.match(sqlTest, /disabled notification trigger emitted an event/u);
  assert.match(sqlTest, /enabled service-role trigger did not emit exactly one event/u);
});
