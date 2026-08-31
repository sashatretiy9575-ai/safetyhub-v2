import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('valid QR replays share one short-lived database projection', async () => {
  const source = await read('features/certificates/server.ts');

  assert.match(source, /unstable_cache/u);
  assert.match(source, /public-certificate-verification-v1/u);
  assert.match(source, /revalidate:\s*15/u);
  assert.match(source, /CERTIFICATE_VERIFICATION_CACHE_TAG/u);
  assert.match(source, /return getCachedPublicCertificate\(certificateId\)/u);
});

test('certificate-changing application flows invalidate the verification cache', async () => {
  const sources = await Promise.all(
    [
      'features/admin/attestations.ts',
      'features/admin/certificates.ts',
      'features/identity/server.ts',
      'features/learning/server.ts',
      'features/admin/server.ts',
      'app/api/profile/account/route.ts',
    ].map(read),
  );

  for (const source of sources) {
    assert.match(source, /invalidateCertificateVerificationCache/u);
  }

  const admin = sources[4];
  const suspension = admin.slice(
    admin.indexOf('export async function setUserSuspended'),
    admin.indexOf('export async function changeUserRole'),
  );
  const reconciliation = admin.slice(
    admin.indexOf('export async function reconcileAuthAdminOperation'),
  );
  assert.match(
    suspension,
    /invalidateCertificateVerificationCache\(\);\s*try \{[\s\S]*request_account_suspension_confirmed[\s\S]*invalidateCertificateVerificationCache\(\)[\s\S]*updateUserById[\s\S]*advanceOutbox\(handle, 'committed'[\s\S]*finally \{\s*invalidateCertificateVerificationCache\(\)/u,
  );
  assert.match(
    reconciliation,
    /const affectsCertificateVisibility =[\s\S]*operation\.operationType === 'suspend' \|\| operation\.operationType === 'restore'[\s\S]*if \(affectsCertificateVisibility\) \{[\s\S]*invalidateCertificateVerificationCache\(\)[\s\S]*try \{[\s\S]*advanceOutbox\(handle, 'committed'[\s\S]*finally \{[\s\S]*if \(affectsCertificateVisibility\) \{[\s\S]*invalidateCertificateVerificationCache\(\)/u,
  );
});
