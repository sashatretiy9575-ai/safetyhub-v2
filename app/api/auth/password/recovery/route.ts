import { NextResponse } from '@/lib/security/api-response';
import { createEphemeralAuthClient } from '@/features/auth/password-change';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { recoveryStartSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';

export async function POST(request: Request) {
  let body: unknown;
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    body = await readJsonBody(request);
  } catch (error) {
    return apiError(error);
  }

  const parsed = recoveryStartSchema.safeParse(body);
  if (
    !parsed.success ||
    (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
  ) {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
  }

  try {
    const supabase = createEphemeralAuthClient();
    const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
      captchaToken: parsed.data.captchaToken,
    });
    if (error) {
      if (error.code === 'captcha_failed') {
        return NextResponse.json({ error: 'CAPTCHA_FAILED' }, { status: 400 });
      }
      if (error.status === 429) {
        return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 });
      }
      return NextResponse.json({ error: 'RECOVERY_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ sent: true });
  } catch {
    return NextResponse.json({ error: 'RECOVERY_UNAVAILABLE' }, { status: 503 });
  }
}
