import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { zhWebAuthnApiError } from '@/features/auth/zh-webauthn-api';
import { processZhRecovery, recoveryLocator } from '@/features/auth/zh-webauthn-server';
import { resolveZhWebAuthnRelyingParty } from '@/features/auth/zh-webauthn-config';
import { zhRecoveryRequestSchema } from '@/features/auth/zh-webauthn-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata, requestSubjectHash } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = zhRecoveryRequestSchema.safeParse(await readJsonBody(request, 384 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'ZH_RECOVERY_FAILED' }, { status: 400 });
    }
    const locator = recoveryLocator(parsed.data.recoveryCode);
    if (!locator) {
      return NextResponse.json({ error: 'ZH_RECOVERY_FAILED' }, { status: 400 });
    }
    const security = requestSecurityMetadata(request);
    const action =
      parsed.data.action === 'options'
        ? ('auth.zh.recovery.options' as const)
        : ('auth.zh.recovery.verify' as const);
    await consumeCoarseQuota(action, security.ipHash);
    await consumeCoarseQuota(
      'auth.zh.recovery.locator',
      requestSubjectHash(locator),
    );
    return NextResponse.json(
      await processZhRecovery(parsed.data, resolveZhWebAuthnRelyingParty(request)),
    );
  } catch (error) {
    return zhWebAuthnApiError(error);
  }
}
