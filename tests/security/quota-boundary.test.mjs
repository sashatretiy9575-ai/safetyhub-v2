import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function read(file) {
  return readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
}

test('actor quota is consumed exactly once at the trusted mutation boundary', async () => {
  const [
    hardening,
    followup,
    persistent,
    startRoute,
    completeRoute,
    avatarRoute,
    exportRoute,
    rateLimit,
  ] = await Promise.all([
    read('supabase/migrations/20260813020000_security_hardening.sql'),
    read('supabase/migrations/20260813030000_security_hardening_followup.sql'),
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('app/api/attempts/route.ts'),
    read('app/api/attempts/[attemptId]/complete/route.ts'),
    read('app/api/profile/avatar/route.ts'),
    read('app/api/admin/attestations/export/route.ts'),
    read('lib/security/rate-limit.ts'),
  ]);

  assert.match(hardening, /private\.enforce_actor_quota\('attempt\.start'\)/);
  assert.match(hardening, /private\.enforce_actor_quota\('attempt\.complete'\)/);
  assert.match(followup, /private\.enforce_actor_quota\('certificate\.export'\)/);
  assert.match(persistent, /create function private\.consume_business_quota_for_actor/);
  assert.match(persistent, /create or replace function private\.enforce_actor_quota/);
  assert.match(persistent, /perform private\.enforce_actor_quota\('attempt\.start'\);\s*begin/);
  assert.match(persistent, /perform private\.enforce_actor_quota\('attempt\.complete'\);\s*begin/);
  assert.match(
    persistent,
    /perform private\.enforce_actor_quota\('certificate\.export'\);\s*begin/,
  );
  assert.doesNotMatch(startRoute, /consumeBusinessQuota/);
  assert.doesNotMatch(completeRoute, /consumeBusinessQuota/);

  // Avatar crosses a service-only boundary, so its actor quota lives in app.
  assert.match(avatarRoute, /consumeBusinessQuota\('avatar\.upload', context\.user\.id\)/);
  // Export resolution is authenticated and atomically consumes its actor quota
  // in SQL; app code keeps only the independent network budget.
  assert.match(exportRoute, /consumeCoarseQuota\('certificate\.export'/);
  assert.doesNotMatch(exportRoute, /consumeBusinessQuota/);
  assert.match(rateLimit, /type BusinessQuotaAction = 'avatar\.upload' \| 'certificate\.pdf'/);
  assert.match(rateLimit, /rpc\('consume_business_quota_for_actor'/);
  assert.doesNotMatch(rateLimit, /rpc\('consume_business_quota',/);

  assert.match(rateLimit, /consumeAdminMutationQuota[\s\S]*consumeCoarseQuota\(action, ipHash\)/);
  assert.doesNotMatch(
    rateLimit.match(/consumeAdminMutationQuota[\s\S]*?\n}\n/)?.[0] ?? '',
    /consumeBusinessQuota/,
  );
});

test('arbitrary actor quota actions are not exposed to browser roles', async () => {
  const [persistent, rateLimit, databaseTypes] = await Promise.all([
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('lib/security/rate-limit.ts'),
    read('lib/supabase/types.ts'),
  ]);

  assert.match(
    persistent,
    /revoke execute on function public\.consume_business_quota\(text\)\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    persistent,
    /revoke execute on function public\.consume_business_quota_for_actor\(uuid,text\)\s+from public, anon, authenticated, service_role;\s*grant execute on function public\.consume_business_quota_for_actor\(uuid,text\)\s+to service_role/,
  );
  assert.match(
    persistent,
    /revoke all on function private\.consume_business_quota_for_actor\(uuid,text\)\s+from public, anon, authenticated, service_role/,
  );
  assert.doesNotMatch(
    persistent,
    /grant execute on function public\.consume_business_quota(?:_for_actor)?\([^)]*\)\s+to (?:anon|authenticated)/,
  );
  assert.match(rateLimit, /type BusinessQuotaAction = 'avatar\.upload' \| 'certificate\.pdf'/);
  assert.doesNotMatch(databaseTypes, /\bconsume_business_quota:\s*\{/);
});

test('coarse network quota identifiers have bounded service-only retention', async () => {
  const [persistent, worker, databaseTypes] = await Promise.all([
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('supabase/functions/storage-reconciler/index.ts'),
    read('lib/supabase/types.ts'),
  ]);

  assert.match(
    persistent,
    /create index coarse_ip_rate_limits_retention_idx\s+on private\.coarse_ip_rate_limits \(window_started_at, ip_hash, action\)/u,
  );
  assert.match(
    persistent,
    /create function public\.prune_coarse_ip_rate_limits\(p_limit integer default 500\)[\s\S]*least\(greatest\(coalesce\(p_limit, 500\), 1\), 1000\)[\s\S]*window_started_at < statement_timestamp\(\) - interval '24 hours'[\s\S]*for update skip locked[\s\S]*delete from private\.coarse_ip_rate_limits/u,
  );
  assert.match(
    persistent,
    /revoke execute on function public\.prune_coarse_ip_rate_limits\(integer\)\s+from public, anon, authenticated, service_role;\s*grant execute on function public\.prune_coarse_ip_rate_limits\(integer\)\s+to service_role/u,
  );
  assert.match(worker, /rpc\(client, 'prune_coarse_ip_rate_limits', \{ p_limit: 500 \}\)/u);
  assert.match(
    databaseTypes,
    /prune_coarse_ip_rate_limits: \{ Args: \{ p_limit\?: number \}; Returns: Json \}/u,
  );
});
