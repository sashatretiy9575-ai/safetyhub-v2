import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { zhWebAuthnApiError } from '@/features/auth/zh-webauthn-api';
import { prepareZhAuthentication } from '@/features/auth/zh-webauthn-server';
import { resolveZhWebAuthnRelyingParty } from '@/features/auth/zh-webauthn-config';
import { zhAuthenticationOptionsSchema } from '@/features/auth/zh-webauthn-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = zhAuthenticationOptionsSchema.safeParse(await readJsonBody(request, 2048));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeCoarseQuota(
      'auth.zh.authentication.options',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(
      await prepareZhAuthentication(resolveZhWebAuthnRelyingParty(request)),
    );
  } catch (error) {
    return zhWebAuthnApiError(error);
  }
}
