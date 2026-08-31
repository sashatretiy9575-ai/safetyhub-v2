import assert from 'node:assert/strict';
import test from 'node:test';
import {
  countryFlag,
  phoneCallingCode,
  phoneCountries,
} from '../../lib/phone.ts';
import { normalizeUserPhone } from '../../lib/phone-normalization.ts';

test('international phone picker keeps Kazakhstan, Russia, and China first', () => {
  assert.deepEqual(phoneCountries().slice(0, 3), ['KZ', 'RU', 'CN']);
  assert.equal(countryFlag('KZ'), '🇰🇿');
  assert.equal(phoneCallingCode('KZ'), '+7');
  assert.equal(phoneCallingCode('CN'), '+86');
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
