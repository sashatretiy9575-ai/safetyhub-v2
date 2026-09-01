import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import {
  createAuthenticationResponse,
  createRegistrationResponse,
  createSoftwareCredential,
} from '../../scripts/software-webauthn.mjs';

const RP_ID = 'safetyhub.kz';
const ORIGIN = 'https://safetyhub.kz';

test('software authenticator produces valid UV registration and assertion evidence', async () => {
  const credential = createSoftwareCredential();
  const registrationChallenge = Buffer.alloc(32, 1).toString('base64url');
  const registration = await verifyRegistrationResponse({
    response: createRegistrationResponse({
      credential,
      challenge: registrationChallenge,
      origin: ORIGIN,
      rpID: RP_ID,
    }),
    expectedChallenge: registrationChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    expectedType: 'webauthn.create',
    requireUserPresence: true,
    requireUserVerification: true,
  });
  assert.equal(registration.verified, true);
  assert.equal(registration.registrationInfo?.userVerified, true);
  assert.equal(registration.registrationInfo?.credential.id, credential.credentialId);
  assert.deepEqual(
    Buffer.from(registration.registrationInfo?.credential.publicKey ?? []),
    credential.publicKeyCose,
  );

  const authenticationChallenge = Buffer.alloc(32, 2).toString('base64url');
  const authentication = await verifyAuthenticationResponse({
    response: createAuthenticationResponse({
      credential,
      challenge: authenticationChallenge,
      origin: ORIGIN,
      rpID: RP_ID,
      nextCounter: 1,
    }),
    expectedChallenge: authenticationChallenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
    expectedType: 'webauthn.get',
    requireUserVerification: true,
    credential: {
      id: credential.credentialId,
      publicKey: credential.publicKeyCose,
      counter: 0,
      transports: ['internal'],
    },
  });
  assert.equal(authentication.verified, true);
  assert.equal(authentication.authenticationInfo.userVerified, true);
  assert.equal(authentication.authenticationInfo.newCounter, 1);
});
