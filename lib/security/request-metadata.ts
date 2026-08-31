import 'server-only';

import { createHmac, randomUUID } from 'node:crypto';

export type AdminRequestMetadata = {
  correlationId: string;
  requestId: string | null;
  ipHash: string;
  userAgent: string | null;
};

function hmacSecret() {
  const secret = process.env.RATE_LIMIT_HMAC_SECRET ?? process.env.SUPABASE_SECRET_KEY;
  if (!secret || secret.length < 32) throw new Error('RATE_LIMIT_HMAC_SECRET_REQUIRED');
  return secret;
}

function coarseIp(value: string | null) {
  const ip = (value ?? '').split(',')[0]?.trim() ?? '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) {
    return `${ip.toLowerCase().split(':').slice(0, 4).join(':')}::/64`;
  }
  return 'unknown';
}

function trustedForwardedIp(headers: Headers) {
  // Provider-specific headers are accepted only when that provider marks the
  // runtime. Generic forwarding is opt-in for a known, sanitizing reverse proxy.
  if (process.env.VERCEL === '1') return headers.get('x-vercel-forwarded-for');
  if (process.env.CF_PAGES === '1') return headers.get('cf-connecting-ip');
  if (process.env.TRUST_PROXY_IP_HEADERS === 'true') return headers.get('x-forwarded-for');
  return null;
}

export function requestSecurityMetadata(request: Request): AdminRequestMetadata {
  const ipHash = createHmac('sha256', hmacSecret())
    .update(coarseIp(trustedForwardedIp(request.headers)), 'utf8')
    .digest('hex');
  const rawRequestId = request.headers.get('x-request-id')?.trim() ?? '';
  const rawUserAgent = request.headers.get('user-agent')?.trim() ?? '';
  return {
    correlationId: randomUUID(),
    requestId:
      rawRequestId.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(rawRequestId)
        ? rawRequestId
        : null,
    ipHash,
    userAgent: rawUserAgent ? rawUserAgent.slice(0, 256) : null,
  };
}
