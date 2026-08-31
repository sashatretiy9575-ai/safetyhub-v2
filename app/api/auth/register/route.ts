import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import {
  finalizeSignupLegalOperation,
  prepareSignupLegalOperation,
} from '@/features/auth/signup-legal';
import { createClient } from '@/lib/supabase/server';
import { getSiteUrl } from '@/features/auth/server';
import { signUpSchema } from '@/lib/validation/auth';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeCoarseQuota } from '@/lib/security/rate-limit';

function isExistingAccountSignupError(error: { code?: string }) {
  return error.code === 'email_exists' || error.code === 'user_already_exists';
}

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = signUpSchema.safeParse(await readJsonBody(request));
    if (
      !parsed.success ||
      (Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) && !parsed.data.captchaToken)
    ) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await consumeCoarseQuota('auth.register', requestSecurityMetadata(request).ipHash);
    const origin = getSiteUrl().replace(/\/$/, '');
    const operation = await prepareSignupLegalOperation(parsed.data.email);
    const { data, error } = await (
      await createClient()
    ).auth.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      options: {
        emailRedirectTo: `${origin}/auth/callback?next=/onboarding`,
        captchaToken: parsed.data.captchaToken,
        data: {
          safetyhubSignupOperationId: operation.operationId,
          safetyhubSignupNonce: operation.signupNonce,
        },
      },
    });

    if (error && !isExistingAccountSignupError(error)) {
      throw error;
    }

    if (!error && data.user) {
      try {
        await finalizeSignupLegalOperation(operation, data.user.id);
      } catch {
        // Confirmation callback retries the idempotent ownership proof.
      }
    }
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
