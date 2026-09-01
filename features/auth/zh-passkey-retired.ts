import { NextResponse } from '@/lib/security/api-response';

/**
 * Historical Chinese WebAuthn endpoints intentionally remain as explicit
 * tombstones.  Returning 410 prevents a stale browser, saved link, or probe
 * from silently reaching the retired credential implementation.
 */
export function zhPasskeyRetiredResponse() {
  return NextResponse.json({ error: 'ZH_AUTH_METHOD_RETIRED' }, { status: 410 });
}
