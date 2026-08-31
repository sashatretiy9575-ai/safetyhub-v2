export const SENSITIVE_API_CACHE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Expires: '0',
  Pragma: 'no-cache',
  'Referrer-Policy': 'no-referrer',
} as const;

export function enforceNoStore<T extends Response>(response: T): T {
  for (const [name, value] of Object.entries(SENSITIVE_API_CACHE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}
