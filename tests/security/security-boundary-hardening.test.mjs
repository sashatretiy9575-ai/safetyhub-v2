import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

test('presentation download capacity uses exact durable service-role interfaces', async () => {
  const [migration, generatedTypes, appTypes, sql] = await Promise.all([
    read('supabase/migrations/20260901108000_security_boundary_hardening.sql'),
    read('lib/supabase/database.generated.ts'),
    read('lib/supabase/types.ts'),
    read('supabase/tests/security_boundary_hardening.sql'),
  ]);

  assert.match(migration, /when 'presentation\.download' then 12/u);
  assert.match(
    migration,
    /when p_action in \([\s\S]*?'presentation\.download'[\s\S]*?\) then 300/u,
  );
  assert.match(migration, /create table private\.course_presentation_download_leases/u);
  assert.match(
    migration,
    /create index course_presentation_download_leases_actor_expires_idx[\s\S]*?\(actor_id, expires_at\)/u,
  );
  assert.match(
    migration,
    /create index course_presentation_download_leases_expires_idx[\s\S]*?\(expires_at\)/u,
  );

  const claim = migration.match(
    /create function public\.claim_course_presentation_download_lease\([\s\S]*?\n\$\$;/u,
  )?.[0];
  assert.ok(claim);
  assert.match(claim, /p_lease_seconds integer default 90/u);
  assert.match(claim, /pg_catalog\.pg_advisory_xact_lock/u);
  assert.match(claim, /lease\.expires_at <= statement_timestamp\(\)/u);
  assert.match(claim, /v_actor_count >= 2/u);
  assert.match(claim, /v_global_count >= 12/u);
  assert.match(claim, /'allowed', true, 'leaseId', v_lease_id, 'retryAfter', 0/u);
  assert.ok(
    claim.indexOf('pg_catalog.pg_advisory_xact_lock') <
      claim.indexOf('select count(*)::integer into v_actor_count'),
  );
  assert.match(
    migration,
    /create function public\.release_course_presentation_download_lease\([\s\S]*?lease\.id = p_lease_id and lease\.actor_id = p_actor_id/u,
  );
  assert.match(
    migration,
    /revoke all on function public\.claim_course_presentation_download_lease[\s\S]*?from public, anon, authenticated, service_role[\s\S]*?grant execute[\s\S]*?to service_role/u,
  );

  for (const source of [generatedTypes, appTypes]) {
    assert.match(source, /claim_course_presentation_download_lease:/u);
    assert.match(source, /Args: \{ p_actor_id: string; p_lease_seconds\?: number \}/u);
    assert.match(source, /release_course_presentation_download_lease:/u);
    assert.match(source, /Args: \{ p_actor_id: string; p_lease_id: string \}|Args: \{ p_lease_id: string; p_actor_id: string \}/u);
  }
  assert.match(sql, /per-actor presentation lease ceiling exceeded two/u);
  assert.match(sql, /global presentation lease ceiling exceeded twelve/u);
  assert.match(sql, /expired presentation lease did not recover capacity atomically/u);
});

test('opaque OTP challenge SQL exercises binding, exhaustion, expiry and grants', async () => {
  const sql = await read('supabase/tests/security_boundary_hardening.sql');

  assert.match(sql, /wrong email binding was distinguishable or consumed an attempt/u);
  assert.match(sql, /for v_attempt in 1\.\.6 loop/u);
  assert.match(sql, /seventh OTP attempt did not return stable challenge exhaustion/u);
  assert.match(sql, /email OTP completion was not single-use/u);
  assert.match(sql, /expired email OTP challenge remained usable or durable/u);
  assert.match(sql, /email OTP challenge RPC grants are not service-role-only/u);
  assert.match(sql, /email OTP challenge exceeded the one-hour lifetime/u);
});
