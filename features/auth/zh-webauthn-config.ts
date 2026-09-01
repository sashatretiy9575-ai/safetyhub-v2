import 'server-only';

export const ZH_WEBAUTHN_PRODUCTION_RP_ID = 'safetyhub.kz';
export const ZH_WEBAUTHN_PRODUCTION_ORIGIN = 'https://safetyhub.kz';
export const ZH_WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * 60;

const DEVELOPMENT_ORIGINS = new Map([
  ['http://localhost:3000', 'localhost'],
  ['http://127.0.0.1:3000', '127.0.0.1'],
]);

function configuredDevelopmentRelyingParty(value: string | undefined) {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' ||
    (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return { origin: url.origin, rpID: url.hostname } as const;
}

export type ZhWebAuthnRelyingParty = Readonly<{
  rpID: string;
  origin: string;
}>;

/**
 * Production and preview deployments are fail-closed to the canonical RP.
 * Only a local non-production process may use the two explicit development
 * origins. No arbitrary Host/Origin value can become a WebAuthn trust root.
 */
export function resolveZhWebAuthnRelyingParty(request: Request): ZhWebAuthnRelyingParty {
  const requestOrigin = new URL(request.url).origin;
  const configuredOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const deploymentIsProduction =
    process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL_ENV);

  if (deploymentIsProduction) {
    if (
      requestOrigin !== ZH_WEBAUTHN_PRODUCTION_ORIGIN ||
      configuredOrigin !== ZH_WEBAUTHN_PRODUCTION_ORIGIN
    ) {
      throw new Error('ZH_WEBAUTHN_ORIGIN_NOT_ALLOWED');
    }
    return {
      rpID: ZH_WEBAUTHN_PRODUCTION_RP_ID,
      origin: ZH_WEBAUTHN_PRODUCTION_ORIGIN,
    };
  }

  if (requestOrigin === ZH_WEBAUTHN_PRODUCTION_ORIGIN) {
    return {
      rpID: ZH_WEBAUTHN_PRODUCTION_RP_ID,
      origin: ZH_WEBAUTHN_PRODUCTION_ORIGIN,
    };
  }
  const configuredDevelopment = configuredDevelopmentRelyingParty(configuredOrigin);
  if (configuredDevelopment?.origin === requestOrigin) return configuredDevelopment;
  const localRpID = configuredOrigin ? null : DEVELOPMENT_ORIGINS.get(requestOrigin);
  if (!localRpID) throw new Error('ZH_WEBAUTHN_ORIGIN_NOT_ALLOWED');
  return { rpID: localRpID, origin: requestOrigin };
}
