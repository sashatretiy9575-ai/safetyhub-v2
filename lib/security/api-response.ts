import { NextResponse as FrameworkNextResponse } from 'next/server';
import { enforceNoStore } from '@/lib/security/no-store';

/**
 * Route-handler responses may override framework-level cache headers. Apply the
 * policy directly to every API response so authenticated data and error bodies
 * cannot be retained by browsers, shared caches, or the Vercel CDN.
 */
export function enforceApiNoStore<T extends Response>(response: T): T {
  return enforceNoStore(response);
}

export function createApiResponse(body?: BodyInit | null, init?: ResponseInit): Response {
  return enforceApiNoStore(new Response(body, init));
}

/**
 * Explicit exception for immutable, content-addressed public media. The caller
 * must supply a stable ETag and the object URL must never expose private data.
 */
export function createImmutableAssetResponse(
  body?: BodyInit | null,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init);
  if (!response.headers.has('ETag')) {
    throw new Error('Immutable asset responses require an ETag.');
  }
  response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  response.headers.set('CDN-Cache-Control', 'public, max-age=31536000, immutable');
  response.headers.set('Vercel-CDN-Cache-Control', 'public, max-age=31536000, immutable');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

/**
 * Explicit exception for private media that is costly to resend and cheap to
 * revalidate. The browser may keep the bytes, but `no-cache` makes it ask
 * before every reuse, so the route's access check still decides each display
 * and a repeat view costs a bodiless 304. Shared caches and the CDN never store
 * it. The caller must supply a strong ETag bound to the exact bytes; pass a
 * null body with status 304 to answer a matching `If-None-Match`.
 *
 * On Vercel a function's Cache-Control wins over the `/api` rule in
 * `next.config.ts`. `next start` and `next dev` do the opposite: a header the
 * config already set is kept and the handler's is dropped, so there this policy
 * only reaches the browser for a path that rule does not cover.
 */
export function createPrivateRevalidatedResponse(
  body?: BodyInit | null,
  init?: ResponseInit,
): Response {
  const response = new Response(body, init);
  if (!response.headers.has('ETag')) {
    throw new Error('Private revalidated responses require an ETag.');
  }
  response.headers.set('Cache-Control', 'private, no-cache, must-revalidate');
  response.headers.set('CDN-Cache-Control', 'no-store');
  response.headers.set('Vercel-CDN-Cache-Control', 'no-store');
  // The stored copy belongs to one signed-in browser session, never to a URL.
  response.headers.set('Vary', 'Cookie');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

/** Drop-in facade for API routes that only need json/redirect. */
export const NextResponse = {
  json<JsonBody>(body: JsonBody, init?: ResponseInit) {
    return enforceApiNoStore(FrameworkNextResponse.json(body, init));
  },
  redirect(url: string | URL, init?: number | ResponseInit) {
    return enforceApiNoStore(FrameworkNextResponse.redirect(url, init));
  },
};
