import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  ADMIN_CAPABILITIES,
  DEFAULT_ADMIN_CAPABILITIES,
  hasAdminCapability,
} from '../../lib/security/capabilities.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

function sqlFunction(source, name) {
  const definition = source.match(
    new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`),
  )?.[0];
  assert.ok(definition, `${name} is missing`);
  return definition;
}

test('ordinary admin gets the bounded operator preset while superadmin-only powers stay excluded', () => {
  const operatorCapabilities = [
    'certificate.issue',
    'certificate.read',
    'certificate.revoke',
    'content.manage',
    'identity.manage',
    'identity.read',
    'notifications.read',
    'results.delete',
    'results.export',
    'results.read',
    'site.settings.manage',
    'test.manage',
    'user.read',
  ];
  assert.deepEqual([...DEFAULT_ADMIN_CAPABILITIES].sort(), operatorCapabilities);
  for (const capability of ADMIN_CAPABILITIES) {
    assert.equal(
      hasAdminCapability(DEFAULT_ADMIN_CAPABILITIES, capability),
      operatorCapabilities.includes(capability),
    );
  }
  assert.equal(hasAdminCapability(DEFAULT_ADMIN_CAPABILITIES, 'role.manage'), false);
  assert.equal(hasAdminCapability(DEFAULT_ADMIN_CAPABILITIES, 'capability.manage'), false);
  assert.equal(hasAdminCapability(DEFAULT_ADMIN_CAPABILITIES, 'future.default-allow'), false);
});

test('database role matrix is deny-by-default and capabilities guard every mutation', async () => {
  const baseline = await read('supabase/migrations/20260813000000_safetyhub_baseline.sql');

  assert.match(baseline, /role\.role = 'superadmin'/);
  assert.match(baseline, /role\.role = 'admin'[\s\S]*catalog\.admin_default/);
  assert.match(baseline, /message = 'CAPABILITY_REQUIRED'/);
  assert.match(
    baseline,
    /revoke execute on all functions in schema public from public, anon, authenticated, service_role/,
  );
  assert.match(
    baseline,
    /revoke all on all tables in schema public from public, anon, authenticated/,
  );
  assert.match(
    baseline,
    /grant execute on function public\.bootstrap_superadmin\(uuid\) to service_role/,
  );
  assert.match(
    baseline,
    /grant execute on function public\.provision_admin_by_email\(text\) to service_role/,
  );
  assert.doesNotMatch(
    baseline,
    /grant execute on function public\.(?:bootstrap_superadmin|provision_admin_by_email)[^;]*to authenticated/,
  );

  const guards = new Map([
    ['confirm_admin_identities', 'identity.manage'],
    ['bulk_update_participants', 'identity.manage'],
    ['issue_certificates', 'certificate.issue'],
    ['revoke_certificates', 'certificate.revoke'],
    ['resolve_certificate_export', 'results.export'],
    ['update_site_settings', 'site.settings.manage'],
    ['manage_user_role_confirmed', 'role.manage'],
    ['set_user_capabilities_confirmed', 'capability.manage'],
  ]);
  for (const [name, capability] of guards) {
    assert.match(
      sqlFunction(baseline, name),
      new RegExp(`require_capability\\('${capability.replace('.', '\\.')}\'\\)`),
    );
  }
});

test('admin read models are bounded and keyset-paginated without offset scans', async () => {
  const baseline = await read('supabase/migrations/20260813000000_safetyhub_baseline.sql');
  for (const name of [
    'list_admin_attestations_page',
    'list_admin_users_page',
    'list_admin_audit_page',
    'list_admin_access_users_page',
    'list_admin_access_outbox_page',
  ]) {
    const definition = sqlFunction(baseline, name);
    assert.match(definition, /limit v_limit \+ 1/);
    assert.doesNotMatch(definition, /\boffset\b/i);
  }
  assert.match(baseline, /create index attestations_completed_idx/);
  assert.match(baseline, /create index attestations_score_idx/);
  assert.match(baseline, /create index audit_created_idx/);
  assert.match(
    baseline,
    /select distinct on \(certificate\.user_id, certificate\.revision_id\)[\s\S]*?\(certificate\.revoked_at is null\) desc,[\s\S]*?certificate\.issued_at desc,[\s\S]*?certificate\.id desc/,
  );
  assert.doesNotMatch(
    baseline.match(
      /create view private\.admin_attestation_rows as[\s\S]*?;\n\ncreate function public\.get_profile_attestations/,
    )?.[0] ?? '',
    /left join lateral[\s\S]*?public\.certificates/,
  );
});

test('reasoned administrative writes are audited per target with batch and correlation metadata', async () => {
  const [baseline, requestMetadata] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('lib/security/request-metadata.ts'),
  ]);

  assert.match(
    baseline,
    /create table public\.admin_audit_log \([\s\S]*actor_user_id[\s\S]*target_user_id[\s\S]*before_data[\s\S]*after_data[\s\S]*reason[\s\S]*batch_id[\s\S]*correlation_id/,
  );
  assert.match(
    sqlFunction(baseline, 'bulk_update_participants'),
    /for v_user_id in select distinct unnest\(p_user_ids\)[\s\S]*private\.confirm_profile_identity/,
  );
  assert.match(
    baseline,
    /create function private\.confirm_profile_identity[\s\S]*insert into public\.admin_audit_log/,
  );
  assert.match(
    sqlFunction(baseline, 'manage_user_role_confirmed'),
    /before_data, after_data, reason, correlation_id/,
  );
  assert.match(requestMetadata, /createHmac\('sha256'/);
  assert.doesNotMatch(requestMetadata, /return \{[\s\S]*\bip:/);
});

test('same-origin route boundary is shared by privileged mutations', async () => {
  const [origin, attestationRoute, contactsRoute] = await Promise.all([
    read('features/auth/request-origin.ts'),
    read('app/api/admin/attestations/actions/route.ts'),
    read('app/api/admin/settings/contacts/route.ts'),
  ]);
  assert.match(origin, /export function isSameOriginRequest/);
  assert.match(
    origin,
    /new URL\(origin\)\.origin === canonicalOrigin && requestOrigin === canonicalOrigin/,
  );
  assert.match(origin, /export function invalidOriginResponse/);
  assert.match(attestationRoute, /invalidOriginResponse\(request\)/);
  assert.match(contactsRoute, /invalidOriginResponse\(request\)/);
});
