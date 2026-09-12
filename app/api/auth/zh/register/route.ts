import { NextResponse } from '@/lib/security/api-response';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { zhUsernamePasswordApiError } from '@/server/auth/zh-username-password-api';
import { registerZhUsernamePassword } from '@/server/auth/zh-username-password';
import { zhUsernamePasswordRegistrationSchema } from '@/lib/auth/zh-username-password-validation';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeCoarseQuota } from '@/server/security/rate-limit';
import { rolloutFeatureEnabled } from '@/lib/rollout-flags';

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    if (!rolloutFeatureEnabled('zhUsernamePassword')) {
      return NextResponse.json({ error: 'ZH_REGISTRATION_FAILED' }, { status: 400 });
    }
    const parsed = zhUsernamePasswordRegistrationSchema.safeParse(
      await readJsonBody(request, 8192),
    );
    if (
      !parsed.success ||
      (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
    ) {
      return NextResponse.json({ error: 'ZH_REGISTRATION_FAILED' }, { status: 400 });
    }
    await consumeCoarseQuota('auth.register', requestSecurityMetadata(request).ipHash);
    const payload = await registerZhUsernamePassword(parsed.data);
    // Registration itself intentionally does not create a browser session.
    // The client subsequently obtains fresh CAPTCHA proof and calls /login;
    // only that successful session response receives the UI session hint.
    return NextResponse.json(payload);
  } catch (error) {
    return zhUsernamePasswordApiError(error);
  }
}
