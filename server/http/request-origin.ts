import { resolveSiteOrigin } from '../../lib/site-url.ts';
import { enforceNoStore } from '../../lib/security/no-store.ts';

export function isSameOriginRequest(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  try {
    const requestOrigin = new URL(request.url).origin;
    const canonicalOrigin = resolveSiteOrigin();
    return new URL(origin).origin === canonicalOrigin && requestOrigin === canonicalOrigin;
  } catch {
    return false;
  }
}

export function invalidOriginResponse(request: Request) {
  return isSameOriginRequest(request)
    ? null
    : enforceNoStore(Response.json({ error: 'INVALID_ORIGIN' }, { status: 403 }));
}
