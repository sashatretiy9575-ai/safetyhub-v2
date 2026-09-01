import 'server-only';

import { createApiResponse } from '@/lib/security/api-response';

export const CERTIFICATE_METADATA_MAX_BYTES = 32 * 1024;
export const CERTIFICATE_EXPORT_METADATA_MAX_BYTES = 2 * 1024 * 1024;

export function createBoundedCertificateMetadataResponse(
  value: unknown,
  maximumBytes: number,
  extraHeaders: HeadersInit = {},
) {
  const body = JSON.stringify(value);
  const byteLength = new TextEncoder().encode(body).byteLength;
  if (byteLength < 2 || byteLength > maximumBytes) {
    throw new Error('CERTIFICATE_METADATA_SIZE_INVALID');
  }
  return createApiResponse(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}
