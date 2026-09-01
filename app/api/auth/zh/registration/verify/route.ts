import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { zhWebAuthnApiError } from '@/features/auth/zh-webauthn-api';
import { verifyZhRegistration } from '@/features/auth/zh-webauthn-server';
import { resolveZhWebAuthnRelyingParty } from '@/features/auth/zh-webauthn-config';
import { zhRegistrationVerifySchema } from '@/features/auth/zh-webauthn-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata, requestSubjectHash } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = zhRegistrationVerifySchema.safeParse(await readJsonBody(request, 512 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'ZH_REGISTRATION_FAILED' }, { status: 400 });
    }
    const security = requestSecurityMetadata(request);
    await consumeCoarseQuota('auth.zh.registration.verify', security.ipHash);
    await consumeCoarseQuota(
      'auth.zh.registration.verify',
      requestSubjectHash(parsed.data.operationId),
    );
    return NextResponse.json(
      await verifyZhRegistration(parsed.data, resolveZhWebAuthnRelyingParty(request)),
    );
  } catch (error) {
    return zhWebAuthnApiError(error);
  }
}
