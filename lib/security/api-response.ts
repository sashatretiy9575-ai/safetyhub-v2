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

/** Drop-in facade for API routes that only need json/redirect. */
export const NextResponse = {
  json<JsonBody>(body: JsonBody, init?: ResponseInit) {
    return enforceApiNoStore(FrameworkNextResponse.json(body, init));
  },
  redirect(url: string | URL, init?: number | ResponseInit) {
    return enforceApiNoStore(FrameworkNextResponse.redirect(url, init));
  },
};
