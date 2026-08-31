import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  countryFlag,
  phoneCallingCode,
  phoneCountryOptions,
  phoneCountries,
} from '../../lib/phone.ts';
import { normalizeUserPhone } from '../../lib/phone-normalization.ts';

test('international phone picker keeps Kazakhstan, Russia, and China first', () => {
  assert.deepEqual(phoneCountries().slice(0, 3), ['KZ', 'RU', 'CN']);
  assert.equal(countryFlag('KZ'), '🇰🇿');
  assert.equal(phoneCallingCode('KZ'), '+7');
  assert.equal(phoneCallingCode('CN'), '+86');
  assert.deepEqual(
    phoneCountryOptions().slice(0, 3).map((option) => option.countryIso2),
    ['KZ', 'RU', 'CN'],
  );
});

test('country labels are serialized by server pages instead of recomputed during hydration', async () => {
  const [phoneInput, onboardingPage, onboardingForm, profilePage, adminAccountPage, profileForm] = await Promise.all([
    readFile(new URL('../../features/profile/phone-input.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/(account)/onboarding/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../features/profile/onboarding-form.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/(account)/profile/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../app/(admin)/admin/account/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../features/auth/profile-form.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(phoneInput, /countryOptions\.map/u);
  assert.doesNotMatch(phoneInput, /countryLabel|phoneCountries|Intl\.DisplayNames/u);
  assert.match(onboardingPage, /countryOptions=\{phoneCountryOptions\(\)\}/u);
  assert.match(onboardingForm, /countryOptions=\{countryOptions\}/u);
  assert.match(profilePage, /countryOptions=\{phoneCountryOptions\(\)\}/u);
  assert.match(adminAccountPage, /countryOptions=\{phoneCountryOptions\(\)\}/u);
  assert.match(profileForm, /countryOptions=\{countryOptions\}/u);
});

test('server phone normalization stores selected country and E.164 only', () => {
  assert.deepEqual(
    normalizeUserPhone({ countryIso2: 'KZ', nationalNumber: '701 729 0349' }),
    { countryIso2: 'KZ', phoneE164: '+77017290349' },
  );
  assert.deepEqual(
    normalizeUserPhone({ countryIso2: 'CN', nationalNumber: '138 0013 8000' }),
    { countryIso2: 'CN', phoneE164: '+8613800138000' },
  );
  assert.equal(normalizeUserPhone({ countryIso2: 'KZ', nationalNumber: '123' }), null);
  assert.equal(normalizeUserPhone({ countryIso2: 'ZZ', nationalNumber: '7017290349' }), null);
});
