import crypto from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function clientData(type, challenge, origin) {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin,
      crossOrigin: false,
    }),
    'utf8',
  );
}

function authenticatorData(rpID, flags, counter) {
  const result = Buffer.alloc(37);
  crypto.createHash('sha256').update(rpID, 'utf8').digest().copy(result, 0);
  result[32] = flags;
  result.writeUInt32BE(counter, 33);
  return result;
}

export function sha256HexText(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createSoftwareCredential() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const jwk = publicKey.export({ format: 'jwk' });
  if (!jwk.x || !jwk.y) throw new Error('software WebAuthn key export failed');
  const publicKeyCose = Buffer.from(
    encodeCBOR(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
        [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
      ]),
    ),
  );
  return {
    credentialId: crypto.randomBytes(32).toString('base64url'),
    userHandle: crypto.randomBytes(32).toString('base64url'),
    publicKeyCose,
    privateKey,
    counter: 0,
  };
}

export function createRegistrationResponse({ credential, challenge, origin, rpID }) {
  const clientDataJSON = clientData('webauthn.create', challenge, origin);
  const credentialId = Buffer.from(credential.credentialId, 'base64url');
  const attestedCredentialData = Buffer.concat([
    Buffer.alloc(16),
    Buffer.from([(credentialId.length >>> 8) & 0xff, credentialId.length & 0xff]),
    credentialId,
    credential.publicKeyCose,
  ]);
  const authData = Buffer.concat([authenticatorData(rpID, 0x45, 0), attestedCredentialData]);
  const attestationObject = encodeCBOR(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', new Uint8Array(authData)],
    ]),
  );
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    response: {
      clientDataJSON: base64url(clientDataJSON),
      attestationObject: base64url(attestationObject),
      transports: ['internal'],
      publicKeyAlgorithm: -7,
      publicKey: base64url(credential.publicKeyCose),
    },
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    type: 'public-key',
  };
}

export function createAuthenticationResponse({ credential, challenge, origin, rpID, nextCounter }) {
  if (!Number.isSafeInteger(nextCounter) || nextCounter < 1 || nextCounter > 0xffff_ffff) {
    throw new Error('software WebAuthn counter is invalid');
  }
  const clientDataJSON = clientData('webauthn.get', challenge, origin);
  const authData = authenticatorData(rpID, 0x05, nextCounter);
  const signed = Buffer.concat([
    authData,
    crypto.createHash('sha256').update(clientDataJSON).digest(),
  ]);
  const signature = crypto.sign('sha256', signed, credential.privateKey);
  return {
    id: credential.credentialId,
    rawId: credential.credentialId,
    response: {
      clientDataJSON: base64url(clientDataJSON),
      authenticatorData: base64url(authData),
      signature: base64url(signature),
      userHandle: credential.userHandle,
    },
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    type: 'public-key',
  };
}
