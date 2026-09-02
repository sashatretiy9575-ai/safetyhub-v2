import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  legalDocumentHref,
  legalEffectiveDateInAppTimezone,
  PRIVACY_POLICY,
  PRIVACY_POLICY_V1_1,
  PRIVACY_POLICY_V1_2,
  PRIVACY_POLICY_V1_3,
  resolveLegalDocumentVersion,
  TERMS_POLICY,
  TERMS_POLICY_V2_1,
  TERMS_POLICY_V2_2,
  TERMS_POLICY_V2_3,
} from '../../lib/legal.ts';

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(stableJson(value)).digest('hex');

test('legal versions are immutable, resolvable, and have exact profile links', () => {
  assert.equal(resolveLegalDocumentVersion('privacy', PRIVACY_POLICY.version), PRIVACY_POLICY);
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY.version), TERMS_POLICY);
  assert.equal(
    resolveLegalDocumentVersion('privacy', PRIVACY_POLICY_V1_1.version),
    PRIVACY_POLICY_V1_1,
  );
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY_V2_1.version), TERMS_POLICY_V2_1);
  assert.equal(
    resolveLegalDocumentVersion('privacy', PRIVACY_POLICY_V1_2.version),
    PRIVACY_POLICY_V1_2,
  );
  assert.equal(resolveLegalDocumentVersion('terms', TERMS_POLICY_V2_2.version), TERMS_POLICY_V2_2);
  assert.equal(PRIVACY_POLICY.bodyRevision, 'privacy-1.4');
  assert.equal(TERMS_POLICY.bodyRevision, 'terms-2.4');
  assert.equal(PRIVACY_POLICY_V1_1.bodyRevision, 'privacy-1.1');
  assert.equal(PRIVACY_POLICY_V1_2.bodyRevision, 'privacy-1.2');
  assert.equal(TERMS_POLICY_V2_1.bodyRevision, 'terms-2.1');
  assert.equal(TERMS_POLICY_V2_2.bodyRevision, 'terms-2.2');
  assert.equal(PRIVACY_POLICY_V1_3.bodyRevision, 'privacy-1.3');
  assert.equal(TERMS_POLICY_V2_3.bodyRevision, 'terms-2.3');
  assert.equal(resolveLegalDocumentVersion('privacy', '999.0'), null);
  assert.equal(legalEffectiveDateInAppTimezone('2026-09-01T19:00:00.000Z'), '2026-09-02');
  assert.equal(
    legalDocumentHref('privacy', PRIVACY_POLICY.version),
    '/privacy?version=1.4#document-version',
  );
  assert.equal(
    legalDocumentHref('terms', TERMS_POLICY.version),
    '/terms?version=2.4#document-version',
  );
});

test('current legal copies accurately disclose the minimal ZH username-password path', async () => {
  const [
    privacyPage,
    termsPage,
    privacySource,
    termsSource,
    privacyComponent,
    termsComponent,
    localizedView,
    legal,
    footer,
    legalContacts,
    ruMessages,
  ] = await Promise.all([
    read('app/(public)/privacy/page.tsx'),
    read('app/(public)/terms/page.tsx'),
    read('content/legal/privacy/1.4.ru.json'),
    read('content/legal/terms/2.4.ru.json'),
    read('components/legal/privacy-policy-v1-4.tsx'),
    read('components/legal/terms-policy-v2-4.tsx'),
    read('components/legal/localized-legal-document.tsx'),
    read('lib/legal.ts'),
    read('components/layout/footer.tsx'),
    read('components/legal/legal-contacts.tsx'),
    read('messages/ru.json'),
  ]);

  for (const page of [privacyPage, termsPage]) {
    assert.match(page, /searchParams:[\s\S]*version\?/);
    assert.match(page, /resolveActivatedLegalPolicy/);
    assert.match(page, /bodyRevision !==/);
    assert.match(page, /bodyRevision ===/);
    assert.doesNotMatch(page, /Пилотная среда|реквизиты оператора ещё не настроены/iu);
    assert.doesNotMatch(page, /LEGAL_REVIEW_NOTICE/);
  }

  assert.match(privacyPage, /privacy-1\.1/);
  assert.match(privacyPage, /privacy-1\.2/);
  assert.match(privacyPage, /privacy-1\.3/);
  assert.match(privacyPage, /privacy-1\.4/);
  assert.match(termsPage, /terms-2\.1/);
  assert.match(termsPage, /terms-2\.2/);
  assert.match(termsPage, /terms-2\.3/);
  assert.match(termsPage, /terms-2\.4/);

  const privacyDocument = JSON.parse(privacySource);
  const termsDocument = JSON.parse(termsSource);
  assert.equal(privacyDocument.version, '1.4');
  assert.equal(termsDocument.version, '2.4');
  assert.equal(privacyDocument.bodySourceSha256, sha256(privacyDocument.body));
  assert.equal(termsDocument.bodySourceSha256, sha256(termsDocument.body));
  const privacy = JSON.stringify(privacyDocument.body);
  const terms = JSON.stringify(termsDocument.body);

  for (const provider of ['Supabase', 'Vercel', 'Cloudflare', 'Telegram']) {
    assert.match(privacy, new RegExp(provider));
  }
  assert.match(privacy, /email OTP/iu);
  assert.match(privacy, /username и пароль/iu);
  assert.match(privacy, /не запрашивает email[^]*фото или passkey/iu);
  assert.match(privacy, /администратор не может его прочитать/iu);
  assert.match(privacy, /synthetic Auth identifier/iu);
  assert.match(privacy, /не требуются профиль[^]*фотография/iu);
  assert.match(privacy, /не выдаёт сертификат автоматически/iu);
  assert.match(privacy, /без username[^]*пароля[^]*synthetic identifier/iu);
  assert.match(privacy, /Локальное хранилище/iu);
  assert.match(terms, /латинский username и пароль/iu);
  assert.match(terms, /не требуются email[^]*другие данные профиля/iu);
  assert.match(terms, /не более 8 новых попыток[^]*Asia\/Oral/iu);
  assert.match(terms, /10 вопросов, четыре варианта ответа/iu);
  assert.match(terms, /7 правильных ответов[^]*70%/iu);
  assert.match(terms, /15 минут/iu);
  assert.match(terms, /Пока заявка ожидает, отклонена[^]*учебные функции недоступны/iu);
  assert.match(terms, /Телефон не используется для входа/iu);
  assert.match(terms, /Synthetic Auth identifier/iu);
  assert.match(terms, /Telegram не принимает решений/iu);
  assert.match(terms, /не создаёт сертификат/iu);
  assert.match(terms, /не является государственной лицензией/iu);
  assert.match(terms, /Оплата в текущей версии сервиса не предусмотрена/iu);
  assert.doesNotMatch(legal, /LEGAL_OPERATOR_(?:NAME|ID|ADDRESS)/);
  assert.doesNotMatch(legalContacts, /mailto:/);
  assert.match(legalContacts, /kind="phone"/);
  assert.match(legalContacts, /kind="whatsapp"/);
  assert.equal((legalContacts.match(/mailto:/gu) ?? []).length, 0);
  assert.ok(legalContacts.indexOf('kind="phone"') < legalContacts.indexOf('kind="whatsapp"'));
  for (const source of [privacySource, termsSource]) {
    assert.doesNotMatch(source, /mailto:/);
    assert.doesNotMatch(source, /tel:/);
  }
  for (const component of [privacyComponent, termsComponent]) {
    assert.match(component, /LocalizedLegalDocumentView/);
    assert.match(component, /bodySourceSha256/);
  }
  for (const locale of ['ru', 'kk', 'en', 'zh']) {
    const [privacyCopy, termsCopy] = await Promise.all([
      read(`content/legal/privacy/1.4.${locale}.json`),
      read(`content/legal/terms/2.4.${locale}.json`),
    ]);
    const privacyLocalized = JSON.parse(privacyCopy);
    const termsLocalized = JSON.parse(termsCopy);
    assert.equal(privacyLocalized.locale, locale);
    assert.equal(termsLocalized.locale, locale);
    assert.equal(privacyLocalized.bodySourceSha256, sha256(privacyLocalized.body));
    assert.equal(termsLocalized.bodySourceSha256, sha256(termsLocalized.body));
  }
  assert.match(localizedView, /<LegalContacts key=/);
  assert.match(localizedView, /variant="compact"/);
  assert.match(localizedView, /max-w-\[52rem\]/);
  assert.doesNotMatch(footer, /Оферта/);
  assert.match(footer, /translations\(link\.messageKey\)/);
  assert.equal(JSON.parse(ruMessages).Shell.footer.terms, 'Условия использования');
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
    legalCurrent,
    privacyPage,
    termsPage,
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
    read('lib/legal-current.ts'),
    read('app/(public)/privacy/page.tsx'),
    read('app/(public)/terms/page.tsx'),
  ]);

  assert.match(profileServer, /rpc\('get_profile_dashboard_locale'/);
  assert.match(profileServer, /p_locale: locale/);
  assert.match(profileServer, /legalAcceptances/);
  assert.match(profilePage, /<LegalAcceptancePanel/);
  assert.match(profilePage, /getProfileDashboard/);
  assert.match(profilePage, /currentPolicies=\{currentPolicies!\}/u);
  assert.match(legalRoute, /accept_current_legal_documents/);
  assert.match(legalRoute, /const currentLegal = await getCurrentLegalPolicies\(\)/u);
  assert.match(legalRoute, /p_privacy_body_revision:\s*currentLegal\.privacy\.bodyRevision/u);
  assert.match(legalRoute, /p_terms_body_revision:\s*currentLegal\.terms\.bodyRevision/u);
  assert.match(
    legalRoute,
    /const acceptances = unwrapRpcMutationResponse\(response\);[\s\S]*NextResponse\.json\(\{ acceptances \}\)/u,
  );
  assert.match(panel, /type="checkbox"/);
  assert.match(panel, /t\('openAccepted'\)/);
  assert.match(
    panel,
    /localizedDocumentHref\([\s\S]*acceptance\.document_type,[\s\S]*acceptance\.version,[\s\S]*locale/,
  );
  assert.match(
    panel,
    /currentDocuments\.every\([\s\S]*recordedKeys\.has\(`\$\{document\.type\}:\$\{document\.version\}`\)/u,
  );
  assert.doesNotMatch(panel, /recorded\.length\s*!==\s*currentDocuments\.length/u);
  assert.match(panel, /onAccepted\?\.\(\)/u);
  assert.match(legalPage, /requireUser\(\{ enforceLegal: false \}\)/u);
  assert.match(legalPage, /<LegalAcceptanceGate/u);
  assert.match(legalPage, /currentPolicies=\{currentPolicies\}/u);
  assert.match(legalGate, /router\.replace\(continueTo\)/u);
  assert.match(legalGate, /currentPolicies=\{currentPolicies\}/u);
  assert.match(legalCurrent, /\.eq\('is_current', true\)/u);
  assert.match(legalCurrent, /data\.length !== 2/u);
  assert.match(legalCurrent, /LEGAL_CURRENT_VERSION_UNSUPPORTED/u);
  assert.match(privacyPage, /resolveActivatedLegalPolicy\('privacy', requestedVersion\)/u);
  assert.match(termsPage, /resolveActivatedLegalPolicy\('terms', requestedVersion\)/u);
  assert.match(otpVerify, /localizedAccountPath\('\/auth\/legal', locale\)/u);
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
  assert.match(
    baselineMigration,
    /from public\.legal_acceptances acceptance\s+where acceptance\.user_id = v_user_id/u,
  );
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
