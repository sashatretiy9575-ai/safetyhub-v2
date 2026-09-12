type ContentSecurityPolicyOptions = Readonly<{
  nonce?: string;
  development?: boolean;
  strict?: boolean;
  environment?: NodeJS.ProcessEnv;
  reportPath?: string | null;
}>;

/**
 * Violations are collected on the product's own origin. A same-origin path
 * keeps the reports inside the deployment, needs no third-party endpoint, and
 * works for both the Chromium `report-to` group and the `report-uri` fallback
 * every other engine still implements.
 */
export const CSP_REPORT_PATH = '/api/security/csp-report';

/** Companion `Reporting-Endpoints` header value for the `csp` group. */
export function reportingEndpointsHeader(origin: string) {
  return `csp="${origin.replace(/\/$/u, '')}${CSP_REPORT_PATH}"`;
}

function directive(name: string, values: string[]) {
  return `${name} ${values.join(' ')}`;
}

function supabaseImageSource(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    const isHostedSupabase =
      url.protocol === 'https:' &&
      (url.hostname === 'supabase.co' || url.hostname.endsWith('.supabase.co'));
    const isLoopback =
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
    return isHostedSupabase || isLoopback
      ? `${url.origin}/storage/v1/object/sign/profile-avatars/`
      : null;
  } catch {
    return null;
  }
}

function supabaseOrigins(environment: NodeJS.ProcessEnv = process.env) {
  const value = environment.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!value) return [];
  try {
    const url = new URL(value);
    const trusted =
      (url.protocol === 'https:' &&
        (url.hostname === 'supabase.co' || url.hostname.endsWith('.supabase.co'))) ||
      ((url.protocol === 'http:' || url.protocol === 'https:') &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    if (!trusted) return [];
    if (url.hostname.endsWith('.supabase.co')) {
      const project = url.hostname.slice(0, -'.supabase.co'.length);
      return [url.origin, `${url.protocol}//${project}.storage.supabase.co`];
    }
    return [url.origin];
  } catch {
    return [];
  }
}

/**
 * Public pages use the static policy so they remain CDN-cacheable. Account and
 * admin HTML receives the nonce policy in proxy.ts, where each request can be
 * rendered with a unique nonce without putting the public site on the dynamic
 * path.
 */
export function buildContentSecurityPolicy({
  nonce,
  development = process.env.NODE_ENV === 'development',
  strict = Boolean(nonce),
  environment = process.env,
  reportPath = CSP_REPORT_PATH,
}: ContentSecurityPolicyOptions = {}) {
  if (strict && !nonce) throw new Error('CSP_NONCE_REQUIRED');
  if (nonce && !/^[A-Za-z0-9+/_-]{16,128}={0,2}$/.test(nonce)) {
    throw new Error('CSP_NONCE_INVALID');
  }

  // pdf.js compiles WebAssembly for its image codecs, which needs
  // 'wasm-unsafe-eval'. Full 'unsafe-eval' is a development-only concession to
  // tooling that rewrites modules on the fly.
  const evaluation = development ? ["'wasm-unsafe-eval'", "'unsafe-eval'"] : ["'wasm-unsafe-eval'"];
  const scripts = strict
    ? [
        "'self'",
        `'nonce-${nonce}'`,
        THEME_BOOTSTRAP_CSP_HASH,
        PWA_INSTALL_BOOTSTRAP_CSP_HASH,
        "'strict-dynamic'",
        ...evaluation,
        'https://challenges.cloudflare.com',
      ]
    : ["'self'", "'unsafe-inline'", ...evaluation, 'https://challenges.cloudflare.com'];
  const styles =
    strict && !development
      ? [
          "'self'",
          `'nonce-${nonce}'`,
          // Turnstile injected stylesheet hash
          "'sha256-nzTgYzXYDNe6BAHiiI7NNlfK8n/auuOAhh2t92YvuXo='",
        ]
      : ["'self'", "'unsafe-inline'"];
  const avatarSource = strict ? supabaseImageSource(environment) : null;
  const storageOrigins = strict ? supabaseOrigins(environment) : [];

  return [
    directive('default-src', ["'self'"]),
    // Chromium reads report-to; every other engine still reads report-uri.
    ...(reportPath ? [directive('report-to', ['csp']), directive('report-uri', [reportPath])] : []),
    directive('script-src', scripts),
    directive('script-src-attr', ["'none'"]),
    directive('style-src', styles),
    // Radix/Floating UI computes popover position with element style
    // attributes. Allow attributes only; injected <style> blocks still need
    // the request nonce and scripts remain nonce-only.
    directive('style-src-attr', ["'unsafe-inline'"]),
    directive('connect-src', ["'self'", ...storageOrigins, 'https://challenges.cloudflare.com']),
    directive('img-src', [
      "'self'",
      'data:',
      'blob:',
      ...storageOrigins,
      ...(avatarSource ? [avatarSource] : []),
    ]),
    directive('font-src', ["'self'"]),
    directive('frame-src', ['https://challenges.cloudflare.com']),
    directive('worker-src', ["'self'", 'blob:', 'https://challenges.cloudflare.com']),
    directive('manifest-src', ["'self'"]),
    directive('media-src', ["'self'"]),
    directive('object-src', ["'none'"]),
    directive('base-uri', ["'self'"]),
    directive('form-action', ["'self'"]),
    directive('frame-ancestors', ["'none'"]),
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export const STATIC_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy({
  development: process.env.NODE_ENV === 'development',
  strict: false,
});
import { THEME_BOOTSTRAP_CSP_HASH } from '@/lib/theme';
import { PWA_INSTALL_BOOTSTRAP_CSP_HASH } from '@/lib/pwa-install-bootstrap';
