import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  legalDocumentHref,
  PRIVACY_POLICY,
  resolveLegalDocumentVersion,
  TERMS_POLICY,
} from '../../lib/legal.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('legal versions are immutable, resolvable, and have exact profile links', () => {
  assert.equal(resolveLegalDocumentVersion('privacy', PRIVACY_POLICY.version), PRIVACY_POLICY);
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY.version), TERMS_POLICY);
  assert.equal(PRIVACY_POLICY.bodyRevision, 'privacy-1.1');
  assert.equal(TERMS_POLICY.bodyRevision, 'terms-2.1');
  assert.equal(resolveLegalDocumentVersion('privacy', '999.0'), null);
  assert.equal(
    legalDocumentHref('privacy', PRIVACY_POLICY.version),
    '/privacy?version=1.1#document-version',
  );
  assert.equal(
    legalDocumentHref('terms', TERMS_POLICY.version),
    '/terms?version=2.1#document-version',
  );
});

test('privacy and terms disclose the implemented data map without a false production promise', async () => {
  const [privacy, terms, legal, footer, legalContacts] = await Promise.all([
    read('app/(public)/privacy/page.tsx'),
    read('app/(public)/terms/page.tsx'),
    read('lib/legal.ts'),
    read('components/layout/footer.tsx'),
    read('components/legal/legal-contacts.tsx'),
  ]);

  for (const page of [privacy, terms]) {
    assert.match(page, /searchParams:[\s\S]*version\?/);
    assert.match(page, /resolveLegalDocumentVersion/);
    assert.match(page, /bodyRevision !==/);
    assert.match(page, /data-body-revision/);
    assert.match(page, /id="document-version"/);
    assert.match(page, /<LegalContacts \/>/);
    assert.doesNotMatch(page, /Пилотная среда|реквизиты оператора ещё не настроены/iu);
    assert.doesNotMatch(page, /LEGAL_REVIEW_NOTICE/);
  }

  for (const provider of ['Supabase', 'Vercel', 'Cloudflare']) {
    assert.match(privacy, new RegExp(provider));
  }
  assert.match(privacy, /localStorage/);
  assert.match(privacy, /auth\/PKCE-cookie/);
  assert.match(privacy, /резервн/iu);
  assert.match(privacy, /трансграничн/iu);
  assert.match(privacy, /окончательном удалении аккаунта[^]*QR-проверка/iu);
  assert.match(privacy, /квадратная\s+фотография/iu);
  assert.match(privacy, /PDF-сертификаты и ZIP-архивы создаются по запросу/iu);
  assert.match(privacy, /вход по email и паролю без MFA/iu);
  assert.match(terms, /не объявляется государственной лицензией/iu);
  assert.match(terms, /Текущая реализация не содержит оплаты/iu);
  assert.doesNotMatch(legal, /LEGAL_OPERATOR_(?:NAME|ID|ADDRESS)/);
  assert.doesNotMatch(legalContacts, /mailto:/);
  assert.match(legalContacts, /kind="phone"/);
  assert.match(legalContacts, /kind="whatsapp"/);
  assert.equal((legalContacts.match(/mailto:/gu) ?? []).length, 0);
  assert.ok(legalContacts.indexOf('kind="phone"') < legalContacts.indexOf('kind="whatsapp"'));
  for (const page of [privacy, terms]) {
    assert.doesNotMatch(page, /mailto:/);
    assert.doesNotMatch(page, /tel:/);
    assert.equal((page.match(/<LegalContacts \/>/gu) ?? []).length, 1);
    assert.match(page, /variant="compact"/);
    assert.match(page, /max-w-\[52rem\]/);
  }
  assert.doesNotMatch(footer, /Оферта/);
  assert.match(footer, /Условия использования/);
});

test('profile reads immutable acceptance history and records current versions explicitly', async () => {
  const [
    profileServer,
    profilePage,
    panel,
    legalRoute,
    register,
    registerRoute,
    signupLegal,
    baselineMigration,
    hardeningMigration,
    databaseTypes,
    authServer,
  ] = await Promise.all([
    read('features/profile/server.ts'),
    read('app/(account)/profile/page.tsx'),
    read('features/profile/legal-acceptance-panel.tsx'),
    read('app/api/profile/legal-acceptances/route.ts'),
    read('app/(account)/auth/register/page.tsx'),
    read('app/api/auth/register/route.ts'),
    read('features/auth/signup-legal.ts'),
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260813070000_persistent_actor_quota.sql'),
    read('lib/supabase/types.ts'),
    read('features/auth/server.ts'),
  ]);

  assert.match(profileServer, /rpc\('get_profile_dashboard'\)/);
  assert.match(profileServer, /legalAcceptances/);
  assert.match(profilePage, /<LegalAcceptancePanel/);
  assert.match(profilePage, /getProfileDashboard/);
  assert.match(legalRoute, /accept_current_legal_documents/);
  assert.match(legalRoute, /p_privacy_body_revision:\s*PRIVACY_POLICY\.bodyRevision/);
  assert.match(legalRoute, /p_terms_body_revision:\s*TERMS_POLICY\.bodyRevision/);
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /Открыть принятую версию/);
  assert.match(panel, /legalDocumentHref\(acceptance\.document_type, acceptance\.version\)/);
  assert.match(panel, /recordedKeys\.has/);
  assert.match(register, /legalDocumentHref\('terms', TERMS_POLICY\.version\)/);
  assert.match(register, /legalDocumentHref\('privacy', PRIVACY_POLICY\.version\)/);
  assert.match(signupLegal, /p_privacy_body_revision:\s*PRIVACY_POLICY\.bodyRevision/);
  assert.match(signupLegal, /p_terms_body_revision:\s*TERMS_POLICY\.bodyRevision/);
  assert.match(registerRoute, /prepareSignupLegalOperation\(parsed\.data\.email\)/);
  assert.match(registerRoute, /finalizeSignupLegalOperation\(operation, data\.user\.id\)/);
  assert.doesNotMatch(registerRoute, /\.identities\b|deleteUser\(|mark_signup_legal_acceptance/);
  assert.doesNotMatch(registerRoute, /legalAcceptance:\s*\{/);
  assert.match(baselineMigration, /create table public\.legal_document_versions/);
  assert.match(baselineMigration, /body_revision/);
  assert.match(baselineMigration, /LEGAL_DOCUMENT_VERSION_IMMUTABLE/);
  assert.match(baselineMigration, /for share/i);
  assert.match(baselineMigration, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(baselineMigration, /LEGAL_VERSION_OUTDATED/);
  assert.match(baselineMigration, /primary key \(user_id, document_type, version\)/i);
  assert.match(baselineMigration, /jsonb_agg[\s\S]*acceptedAt[\s\S]*acceptance\.source/i);
  assert.match(hardeningMigration, /create table private\.signup_legal_operations/);
  assert.match(hardeningMigration, /create function public\.prepare_signup_legal_operation/);
  assert.match(hardeningMigration, /create function public\.finalize_signup_legal_operation/);
  assert.match(hardeningMigration, /nonce_sha256 bytea not null/);
  assert.match(hardeningMigration, /completed_user_id uuid/);
  assert.match(databaseTypes, /export type LegalAcceptanceRow/);
  assert.match(databaseTypes, /p_privacy_body_revision:\s*string/);
  assert.match(databaseTypes, /p_terms_body_revision:\s*string/);
  assert.match(databaseTypes, /has_current_legal_acceptance:\s*boolean/);
  assert.match(authServer, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(authServer, /options\.enforceLegal !== false/);
  assert.match(profilePage, /requireUser\(\{ enforceLegal: false \}\)/);
});
