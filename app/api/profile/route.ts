import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { profileSubmissionSchema } from '@/lib/validation/profile';
import { readJsonBody } from '@/lib/security/request-body';
import { normalizeUserPhone } from '@/lib/phone-server';
import { consumeBusinessQuota, consumeCoarseQuota } from '@/lib/security/rate-limit';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

type TrustedProfileSubmissionRpcClient = {
  rpc(
    name: 'submit_profile_for_approval_from_trusted_server',
    args: {
      p_user_id: string;
      p_name: string;
      p_surname: string;
      p_job: string;
      p_organization: string;
      p_phone_country_iso2: string;
      p_phone_e164: string;
    },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const context = await requireUser();
    const parsed = profileSubmissionSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_PROFILE' }, { status: 400 });
    }
    const phone = normalizeUserPhone(parsed.data.phone);
    if (!phone) {
      return NextResponse.json({ error: 'INVALID_PHONE' }, { status: 400 });
    }

    await Promise.all([
      consumeBusinessQuota('profile.update', context.user.id),
      consumeCoarseQuota('profile.update', requestSecurityMetadata(request).ipHash),
    ]);
    const response = await (createAdminClient() as unknown as TrustedProfileSubmissionRpcClient).rpc(
      'submit_profile_for_approval_from_trusted_server',
      {
      p_user_id: context.user.id,
      p_name: parsed.data.name,
      p_surname: parsed.data.surname,
      p_job: parsed.data.job,
      p_organization: parsed.data.organization,
      p_phone_country_iso2: phone.countryIso2,
      p_phone_e164: phone.phoneE164,
      },
    );
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
