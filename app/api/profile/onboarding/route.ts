import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { onboardingProfileSchema } from '@/lib/validation/profile';
import { readJsonBody } from '@/lib/security/request-body';

type OnboardingRpcClient = {
  rpc: (
    name: 'complete_profile_onboarding',
    args: {
      p_name: string;
      p_surname: string;
      p_job: string;
      p_organization: string;
    },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const context = await requireUser();
    const parsed = onboardingProfileSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_PROFILE' }, { status: 400 });
    }

    if (!context.profile.avatar_updated_at) {
      return NextResponse.json({ error: 'AVATAR_REQUIRED' }, { status: 409 });
    }

    const supabase = await createClient();
    const response = await (supabase as unknown as OnboardingRpcClient).rpc(
      'complete_profile_onboarding',
      {
        p_name: parsed.data.name,
        p_surname: parsed.data.surname,
        p_job: parsed.data.job,
        p_organization: parsed.data.organization,
      },
    );
    unwrapRpcMutationResponse(response);
    return NextResponse.json({ completed: true });
  } catch (error) {
    return apiError(error);
  }
}
