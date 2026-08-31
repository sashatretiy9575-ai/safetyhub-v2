import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => readFile(path.join(root, file), 'utf8');

const guardedRoutes = new Map([
  ['app/api/admin/users/[userId]/identity/route.ts', 'admin.identity.mutate'],
  ['app/api/admin/certificates/[certificateId]/revoke/route.ts', 'admin.certificate.revoke'],
  ['app/api/admin/courses/route.ts', 'admin.test.mutate'],
  ['app/api/admin/courses/[courseId]/status/route.ts', 'admin.test.mutate'],
  ['app/api/admin/courses/[courseId]/presentation/upload-token/route.ts', 'admin.test.mutate'],
  ['app/api/admin/courses/[courseId]/presentation/finalize/route.ts', 'admin.test.mutate'],
  ['app/api/admin/courses/[courseId]/presentation/[presentationId]/route.ts', 'admin.test.mutate'],
  ['app/api/admin/articles/initial-import/route.ts', 'content.article.mutate'],
  ['app/api/admin/users/[userId]/learning-history/route.ts', 'admin.test.mutate'],
  ['app/api/admin/attestations/actions/route.ts', 'admin.attestation.mutate'],
  ['app/api/admin/organizations/merge/route.ts', 'admin.attestation.mutate'],
  ['app/api/admin/settings/contacts/route.ts', 'site.settings.update'],
]);

test('every live privileged mutation applies same-origin and shared actor/IP quotas', async () => {
  for (const [file, action] of guardedRoutes) {
    const source = await read(file);
    assert.match(
      source,
      /invalidOriginResponse\(request\)/,
      `${file} must reject cross-origin writes`,
    );
    assert.match(
      source,
      /requestSecurityMetadata\(request\)\.ipHash|metadata\.ipHash/,
      `${file} must derive a coarse IP hash`,
    );
    assert.match(
      source,
      new RegExp(`consumeAdminMutationQuota\\(\\s*'${action.replaceAll('.', '\\.')}'`),
      `${file} must use the ${action} quota`,
    );
    const quotaIndex = source.indexOf('await consumeAdminMutationQuota');
    const authorizationIndex = source.lastIndexOf('await require', quotaIndex);
    assert.ok(
      authorizationIndex >= 0 && authorizationIndex < quotaIndex,
      `${file} must authenticate/capability-check before charging the shared IP budget`,
    );
  }
});

test('shared admin mutation limiter consumes the app-layer coarse-IP budget', async () => {
  const [rateLimit, baseline, securityHardening, emailOtpLimits] = await Promise.all([
    read('lib/security/rate-limit.ts'),
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260813020000_security_hardening.sql'),
    read('supabase/migrations/20260831100000_email_otp_rate_limits.sql'),
  ]);
  const quotaContracts = [baseline, securityHardening, emailOtpLimits].join('\n');
  assert.match(rateLimit, /export async function consumeAdminMutationQuota/);
  assert.match(rateLimit, /await consumeCoarseQuota\(action, ipHash\)/);
  assert.match(
    rateLimit,
    /Actor quotas are consumed atomically inside each authenticated mutation/u,
  );
  for (const action of new Set(guardedRoutes.values())) {
    assert.match(quotaContracts, new RegExp(`when '${action.replaceAll('.', '\\.')}' then`));
  }
});

test('bulk attestation mutations reject duplicate target amplification', async () => {
  const source = await read('app/api/admin/attestations/actions/route.ts');
  assert.match(source, /new Set\(values\)\.size === values\.length/);
  assert.match(source, /DUPLICATE_TARGET_IDS/);
});
