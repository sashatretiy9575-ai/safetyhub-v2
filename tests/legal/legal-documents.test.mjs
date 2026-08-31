import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  legalDocumentHref,
  PRIVACY_POLICY,
  PRIVACY_POLICY_V1_1,
  resolveLegalDocumentVersion,
  TERMS_POLICY,
  TERMS_POLICY_V2_1,
} from '../../lib/legal.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('legal versions are immutable, resolvable, and have exact profile links', () => {
  assert.equal(resolveLegalDocumentVersion('privacy', PRIVACY_POLICY.version), PRIVACY_POLICY);
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY.version), TERMS_POLICY);
  assert.equal(
    resolveLegalDocumentVersion('privacy', PRIVACY_POLICY_V1_1.version),
    PRIVACY_POLICY_V1_1,
  );
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY_V2_1.version), TERMS_POLICY_V2_1);
  assert.equal(PRIVACY_POLICY.bodyRevision, 'privacy-1.2');
  assert.equal(TERMS_POLICY.bodyRevision, 'terms-2.2');
  assert.equal(PRIVACY_POLICY_V1_1.bodyRevision, 'privacy-1.1');
  assert.equal(TERMS_POLICY_V2_1.bodyRevision, 'terms-2.1');
  assert.equal(resolveLegalDocumentVersion('privacy', '999.0'), null);
  assert.equal(
    legalDocumentHref('privacy', PRIVACY_POLICY.version),
    '/privacy?version=1.2#document-version',
  );
  assert.equal(
    legalDocumentHref('terms', TERMS_POLICY.version),
    '/terms?version=2.2#document-version',
  );
});

test('current legal copies disclose passwordless access, contact-phone use, approval, and the course contract', async () => {
  const [privacyPage, termsPage, privacy, terms, legal, footer, legalContacts] = await Promise.all([
    read('app/(public)/privacy/page.tsx'),
    read('app/(public)/terms/page.tsx'),
    read('components/legal/privacy-policy-v1-2.tsx'),
    read('components/legal/terms-policy-v2-2.tsx'),
    read('lib/legal.ts'),
    read('components/layout/footer.tsx'),
    read('components/legal/legal-contacts.tsx'),
  ]);

  for (const page of [privacyPage, termsPage]) {
    assert.match(page, /searchParams:[\s\S]*version\?/);
    assert.match(page, /resolveLegalDocumentVersion/);
    assert.match(page, /bodyRevision !==/);
    assert.match(page, /bodyRevision ===/);
    assert.match(page, /data-body-revision/);
    assert.doesNotMatch(page, /Пилотная среда|реквизиты оператора ещё не настроены/iu);
    assert.doesNotMatch(page, /LEGAL_REVIEW_NOTICE/);
  }

  assert.match(privacyPage, /privacy-1\.1/);
  assert.match(privacyPage, /privacy-1\.2/);
  assert.match(termsPage, /terms-2\.1/);
  assert.match(termsPage, /terms-2\.2/);

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
  assert.match(privacy, /одноразовым кодом[^]*email OTP/iu);
  assert.match(privacy, /Пароль, SMS-код и номер телефона для аутентификации не\s+используются/iu);
  assert.match(privacy, /контактный номер[^]*не используется для входа/iu);
  assert.match(privacy, /ручную проверку[^]*24 часов/iu);
  assert.match(terms, /email OTP/iu);
  assert.match(terms, /не более 8 новых попыток[^]*Asia\/Oral/iu);
  assert.match(terms, /10 вопросов[^]*четырьмя вариантами ответа/iu);
  assert.match(terms, /7 вопросов[^]*70%/iu);
  assert.match(terms, /15 минут/iu);
  assert.match(
    terms,
    /Пока заявка ожидает решения или отклонена[^]*закрытые\s+учебные функции недоступны/iu,
  );
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

test('profile reads immutable acceptance history and records consent through a separate post-OTP action', async () => {
  const [
    profileServer,
    profilePage,
    panel,
    legalRoute,
    legalPage,
    legalGate,
    otpVerify,
    otpFlow,
    baselineMigration,
    legalRotationMigration,
    databaseTypes,
    authServer,
  ] = await Promise.all([
    read('features/profile/server.ts'),
    read('app/(account)/profile/page.tsx'),
    read('features/profile/legal-acceptance-panel.tsx'),
    read('app/api/profile/legal-acceptances/route.ts'),
    read('app/(account)/auth/legal/page.tsx'),
    read('features/auth/legal-acceptance-gate.tsx'),
    read('app/api/auth/email-otp/verify/route.ts'),
    read('features/auth/email-otp-flow.tsx'),
    read('supabase/migrations/20260813000000_safetyhub_baseline.sql'),
    read('supabase/migrations/20260831114000_passwordless_approval_legal_versions.sql'),
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
  assert.match(
    legalRoute,
    /const acceptances = unwrapRpcMutationResponse\(response\);[\s\S]*NextResponse\.json\(\{ acceptances \}\)/u,
  );
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /Открыть принятую версию/);
  assert.match(panel, /legalDocumentHref\(acceptance\.document_type, acceptance\.version\)/);
  assert.match(panel, /recordedKeys\.has/);
  assert.match(panel, /onAccepted\?\.\(\)/u);
  assert.match(legalPage, /requireUser\(\{ enforceLegal: false \}\)/u);
  assert.match(legalPage, /<LegalAcceptanceGate/u);
  assert.match(legalGate, /router\.replace\(continueTo\)/u);
  assert.match(otpVerify, /return '\/auth\/legal'/u);
  assert.doesNotMatch(
    otpVerify,
    /accept_current_legal_documents|legalAccepted|parsed\.data\.intent/u,
  );
  assert.doesNotMatch(otpFlow, /legalAccepted|sessionStorage[\s\S]*consent/u);
  assert.match(baselineMigration, /create table public\.legal_document_versions/);
  assert.match(baselineMigration, /body_revision/);
  assert.match(baselineMigration, /LEGAL_DOCUMENT_VERSION_IMMUTABLE/);
  assert.match(baselineMigration, /for share/i);
  assert.match(baselineMigration, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(baselineMigration, /LEGAL_VERSION_OUTDATED/);
  assert.match(baselineMigration, /primary key \(user_id, document_type, version\)/i);
  assert.match(baselineMigration, /jsonb_agg[\s\S]*acceptedAt[\s\S]*acceptance\.source/i);
  assert.match(legalRotationMigration, /public\.publish_legal_document_version/);
  assert.match(legalRotationMigration, /'privacy',\s*'1\.2',\s*'privacy-1\.2'/u);
  assert.match(legalRotationMigration, /'terms',\s*'2\.2',\s*'terms-2\.2'/u);
  assert.doesNotMatch(legalRotationMigration, /delete from public\.legal_document_versions/iu);
  assert.doesNotMatch(legalRotationMigration, /update public\.legal_document_versions/iu);
  assert.match(databaseTypes, /export type LegalAcceptanceRow/);
  assert.match(databaseTypes, /p_privacy_body_revision:\s*string/);
  assert.match(databaseTypes, /p_terms_body_revision:\s*string/);
  assert.match(databaseTypes, /has_current_legal_acceptance:\s*boolean/);
  assert.match(authServer, /LEGAL_ACCEPTANCE_REQUIRED/);
  assert.match(authServer, /options\.enforceLegal !== false/);
  assert.match(profilePage, /requireUser\(\{ enforceLegal: false \}\)/);
});
