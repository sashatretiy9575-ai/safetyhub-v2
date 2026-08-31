import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  certificateVerificationUrl,
  createCertificateVerificationToken,
  isCertificateVerificationToken,
  verifyCertificateVerificationToken,
} from '../../lib/certificates/verification.ts';

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const certificateId = '5f0c6f0e-5f2d-4f69-8a2e-34ac10f4892e';
const current = {
  NODE_ENV: 'test',
  CERTIFICATE_VERIFICATION_SECRET: 'current-secret-with-enough-entropy-for-a-real-environment',
};

test('versioned HMAC token round-trips and any altered byte is rejected', () => {
  const token = createCertificateVerificationToken(certificateId, current);
  assert.match(token, /^v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(isCertificateVerificationToken(token), true);
  assert.equal(verifyCertificateVerificationToken(token, current), certificateId);

  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(verifyCertificateVerificationToken(tampered, current), null);
  assert.equal(verifyCertificateVerificationToken('../certificate', current), null);
  assert.equal(
    certificateVerificationUrl('https://safetyhub.kz/', token),
    `https://safetyhub.kz/verify/${token}`,
  );
});

test('secret rotation accepts the previous secret but signs only with the current secret', () => {
  const previousEnvironment = {
    NODE_ENV: 'test',
    CERTIFICATE_VERIFICATION_SECRET: 'previous-secret-with-enough-entropy-for-a-real-environment',
  };
  const previousToken = createCertificateVerificationToken(certificateId, previousEnvironment);
  const rotationEnvironment = {
    ...current,
    CERTIFICATE_VERIFICATION_PREVIOUS_SECRET: previousEnvironment.CERTIFICATE_VERIFICATION_SECRET,
  };

  assert.equal(verifyCertificateVerificationToken(previousToken, current), null);
  assert.equal(
    verifyCertificateVerificationToken(previousToken, rotationEnvironment),
    certificateId,
  );
  assert.notEqual(
    createCertificateVerificationToken(certificateId, rotationEnvironment),
    previousToken,
  );
});

test('production fails closed without a verification secret', () => {
  assert.throws(
    () => createCertificateVerificationToken(certificateId, { NODE_ENV: 'production' }),
    /CERTIFICATE_VERIFICATION_SECRET_MISSING/,
  );
});

test('current and previous verification secrets both require at least 32 characters', () => {
  assert.throws(
    () =>
      createCertificateVerificationToken(certificateId, {
        NODE_ENV: 'production',
        CERTIFICATE_VERIFICATION_SECRET: 'too-short',
      }),
    /CERTIFICATE_VERIFICATION_SECRET_TOO_SHORT/,
  );
  const currentToken = createCertificateVerificationToken(certificateId, current);
  assert.throws(
    () =>
      verifyCertificateVerificationToken(currentToken, {
        ...current,
        CERTIFICATE_VERIFICATION_PREVIOUS_SECRET: 'also-too-short',
      }),
    /CERTIFICATE_VERIFICATION_PREVIOUS_SECRET_TOO_SHORT/,
  );
});

test('certificate verification stores no token or document bytes in Postgres or Storage', async () => {
  const [baseline, server, pdfRoute, exportRoute] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('features/certificates/server.ts'),
    read('app/api/certificates/[certificateId]/route.ts'),
    read('app/api/admin/attestations/export/route.ts'),
  ]);

  assert.match(baseline, /create table public\.certificates/);
  assert.match(baseline, /Immutable certificate metadata snapshots only/);
  assert.doesNotMatch(baseline, /create table [^;]*(?:verification_tokens|pdf_projection)/i);
  assert.doesNotMatch(baseline, /pdf_base64|pdf_bytes|bytea[^;]*certificate/i);
  assert.match(server, /verifyCertificateVerificationToken\(token\)/);
  assert.match(server, /rpc\('get_public_certificate'/);
  assert.match(pdfRoute, /Content-Disposition/);
  assert.doesNotMatch(`${pdfRoute}\n${exportRoute}`, /\.storage\.|pdf_projection|pdf_base64/);
});

test('course deletion metadata never enters certificate download or public verification payloads', async () => {
  const [baseline, publicOverride, server, pdfRoute] = await Promise.all([
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('features/certificates/server.ts'),
    read('app/api/certificates/[certificateId]/route.ts'),
  ]);

  const downloadPayload = baseline.match(
    /create function private\.certificate_download_payload[\s\S]+?\n\$\$;/,
  )?.[0];
  const publicPayload = publicOverride.match(
    /create or replace function public\.get_public_certificate[\s\S]+?\n\$\$;/,
  )?.[0];

  assert.ok(downloadPayload);
  assert.ok(publicPayload);
  for (const payload of [downloadPayload, publicPayload, server, pdfRoute]) {
    assert.doesNotMatch(payload, /courseDeleted|course_deleted_at/i);
  }
  assert.match(downloadPayload, /'testTitle', certificate\.test_title/);
  assert.match(publicPayload, /'testTitle', certificate\.test_title/);
});
