type SiteEnvironment = Record<string, string | undefined>;

const LOCAL_ORIGIN = 'http://localhost:3000';
export const PRODUCTION_SITE_ORIGIN = 'https://safetyhub.kz';

function parseOrigin(value: string, label: string, httpsRequired: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL.`);
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must contain only an origin.`);
  }
  if (httpsRequired && url.protocol !== 'https:') {
    throw new Error(`${label} must use HTTPS.`);
  }
  if (!httpsRequired && !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} must use HTTP or HTTPS.`);
  }
  return url.origin;
}

export function isPreviewDeployment(environment: SiteEnvironment = process.env) {
  return environment.VERCEL_ENV === 'preview';
}

export function assertDeploymentSiteUrl(environment: SiteEnvironment = process.env) {
  if (environment.VERCEL_ENV === 'production') {
    const configured = environment.NEXT_PUBLIC_SITE_URL?.trim();
    if (!configured) {
      throw new Error('NEXT_PUBLIC_SITE_URL is required for a production deployment.');
    }
    const productionOrigin = parseOrigin(configured, 'NEXT_PUBLIC_SITE_URL', true);
    if (productionOrigin !== PRODUCTION_SITE_ORIGIN) {
      throw new Error(`NEXT_PUBLIC_SITE_URL must equal ${PRODUCTION_SITE_ORIGIN} in production.`);
    }
  }

  if (environment.VERCEL_ENV === 'preview') {
    const previewHost = environment.VERCEL_URL?.trim();
    if (!previewHost) throw new Error('VERCEL_URL is required for a preview deployment.');
    parseOrigin(`https://${previewHost.replace(/^https?:\/\//, '')}`, 'VERCEL_URL', true);
  }
}

export function resolveSiteOrigin(
  requestOrigin?: string,
  environment: SiteEnvironment = process.env,
) {
  assertDeploymentSiteUrl(environment);

  if (environment.VERCEL_ENV === 'preview') {
    return parseOrigin(
      `https://${environment.VERCEL_URL!.replace(/^https?:\/\//, '')}`,
      'VERCEL_URL',
      true,
    );
  }

  const configured = environment.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) {
    return parseOrigin(
      configured,
      'NEXT_PUBLIC_SITE_URL',
      environment.VERCEL_ENV === 'production',
    );
  }
  if (requestOrigin) return parseOrigin(requestOrigin, 'Request origin', false);
  return LOCAL_ORIGIN;
}

