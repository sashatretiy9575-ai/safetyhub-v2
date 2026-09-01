import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { zhWebAuthnApiError } from '@/features/auth/zh-webauthn-api';
import { prepareZhRegistration } from '@/features/auth/zh-webauthn-server';
import { resolveZhWebAuthnRelyingParty } from '@/features/auth/zh-webauthn-config';
import { zhRegistrationOptionsSchema } from '@/features/auth/zh-webauthn-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata, requestSubjectHash } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = zhRegistrationOptionsSchema.safeParse(await readJsonBody(request, 32 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const security = requestSecurityMetadata(request);
    await consumeCoarseQuota('auth.zh.registration.options', security.ipHash);
    await consumeCoarseQuota(
      'auth.zh.registration.options',
      requestSubjectHash(
        `${parsed.data.phone.countryIso2}:${parsed.data.phone.nationalNumber}`,
      ),
    );
    return NextResponse.json(
      await prepareZhRegistration(parsed.data, resolveZhWebAuthnRelyingParty(request)),
    );
  } catch (error) {
    return zhWebAuthnApiError(error);
  }
}
