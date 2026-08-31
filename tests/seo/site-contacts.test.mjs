import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  contactPhoneHref,
  contactWhatsappHref,
  formatPhoneDisplay,
  normalizePhoneE164,
} from '../../lib/site-contacts-shared.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

test('contact normalization accepts local formatting and produces canonical links', () => {
  assert.equal(normalizePhoneE164('+7 (701) 729-03-49'), '+77017290349');
  assert.equal(normalizePhoneE164('8 701 729 03 49'), '+77017290349');
  assert.equal(formatPhoneDisplay('+77017290349'), '+7 701 729 0349');
  const contacts = {
    phoneE164: '+77017290349',
    phoneDisplay: '+7 701 729 0349',
    whatsappE164: '+77017290349',
    whatsappSameAsPhone: true,
    version: 1,
    updatedAt: null,
    updatedBy: null,
  };
  assert.equal(contactPhoneHref(contacts), 'tel:+77017290349');
  assert.equal(contactWhatsappHref(contacts), 'https://wa.me/77017290349');
});

test('public contacts are server cached and rendered into contact and SEO components', async () => {
  const [contacts, layout, seo, shell, adminRoute] = await Promise.all([
    read('lib/site-contacts.ts'),
    read('app/(public)/layout.tsx'),
    read('lib/seo.ts'),
    read('components/layout/app-shell.tsx'),
    read('app/api/admin/settings/contacts/route.ts'),
  ]);
  assert.match(contacts, /SAFETYHUB_GLOBAL_CONTACTS/);
  assert.match(contacts, /unstable_cache/);
  assert.match(contacts, /SITE_CONTACTS_REVALIDATE_SECONDS = 60 \* 60/);
  assert.match(contacts, /get_site_settings/);
  assert.match(layout, /organizationJsonLd\(contacts\)/);
  assert.match(layout, /localBusinessJsonLd\(contacts\)/);
  assert.match(seo, /telephone: contacts\.phoneDisplay/);
  assert.match(shell, /getSiteContacts/);
  assert.match(adminRoute, /invalidOriginResponse/);
  assert.match(adminRoute, /status: 409/);
});

test('application contact surfaces use ContactLink instead of duplicated literal URLs', async () => {
  const checked = [
    'components/layout/header.tsx',
    'components/layout/footer.tsx',
    'components/shared/contact-actions.tsx',
    'components/legal/legal-contacts.tsx',
    'components/marketing/faq-accordion.tsx',
    'features/profile/account-approval-status.tsx',
  ];
  for (const relative of checked) {
    const source = await read(relative);
    assert.doesNotMatch(source, /href=\{`tel:/);
    assert.doesNotMatch(source, /href=\{[^}]*wa\.me/);
    assert.doesNotMatch(source, /\+7\s*701\s*729\s*0349/);
  }

  const approvalStatus = await read('features/profile/account-approval-status.tsx');
  assert.match(approvalStatus, /<ContactLink\s+kind="phone"\s+contacts=\{contacts\}/);
  assert.match(approvalStatus, /<ContactLink\s+kind="whatsapp"\s+contacts=\{contacts\}/);
});

test('article WhatsApp actions resolve through current global contacts instead of stored wa.me links', async () => {
  const [validation, renderer, articlePage] = await Promise.all([
    read('lib/validation/article.ts'),
    read('components/article-renderer/index.tsx'),
    read('app/(public)/blog/[slug]/page.tsx'),
  ]);

  assert.match(validation, /ARTICLE_WHATSAPP_ACTION_URL/);
  assert.doesNotMatch(validation, /hostname === 'wa\.me'/);
  assert.match(renderer, /<ContactLink kind="whatsapp" contacts=\{contacts\}/);
  assert.match(articlePage, /getSiteContacts\(\)/);
  assert.match(articlePage, /contacts=\{contacts\}/);
});
