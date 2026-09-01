import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { zhUsernamePasswordApiError } from '@/features/auth/zh-username-password-api';
import { loginWithZhUsernamePassword } from '@/features/auth/zh-username-password-server';
import { zhUsernamePasswordLoginSchema } from '@/features/auth/zh-username-password-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    if (!rolloutFeatureEnabled('zhUsernamePassword')) {
      return NextResponse.json({ error: 'ZH_AUTHENTICATION_FAILED' }, { status: 401 });
    }
    const parsed = zhUsernamePasswordLoginSchema.safeParse(await readJsonBody(request, 8192));
    if (
      !parsed.success ||
      (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
    ) {
      return NextResponse.json({ error: 'ZH_AUTHENTICATION_FAILED' }, { status: 401 });
    }
    await consumeCoarseQuota('auth.otp.verify', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await loginWithZhUsernamePassword(parsed.data));
  } catch (error) {
    return zhUsernamePasswordApiError(error);
  }
}
