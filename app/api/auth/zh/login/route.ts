import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { zhUsernamePasswordApiError } from '@/server/auth/zh-username-password-api';
import { loginWithZhUsernamePassword } from '@/server/auth/zh-username-password';
import { zhUsernamePasswordLoginSchema } from '@/lib/auth/zh-username-password-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { rolloutFeatureEnabled } from '@/lib/rollout-flags';
import { setSafetyHubSessionHint } from '@/server/supabase/session-hint';

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
    const payload = await loginWithZhUsernamePassword(parsed.data);
    const response = NextResponse.json(payload);
    return payload.verified === true ? setSafetyHubSessionHint(request, response) : response;
  } catch (error) {
    return zhUsernamePasswordApiError(error);
  }
}
