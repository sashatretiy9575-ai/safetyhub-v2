import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { requireUser } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { profileSubmissionSchema } from '@/lib/validation/profile';
import { readJsonBody } from '@/lib/security/request-body';
import { normalizeUserPhone } from '@/server/phone';
import { consumeBusinessQuota, consumeCoarseQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

type TrustedProfileSubmissionRpcClient = {
  rpc(
    name: 'submit_profile_for_approval_from_trusted_server',
    args: {
      p_user_id: string;
      p_name: string;
      p_surname: string;
      p_job: string;
      p_organization: string;
      p_phone_country_iso2: string | null;
      p_phone_e164: string | null;
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
    // No number is fine; a number that does not parse is not.
    const phone = parsed.data.phone.nationalNumber ? normalizeUserPhone(parsed.data.phone) : null;
    if (parsed.data.phone.nationalNumber && !phone) {
      return NextResponse.json({ error: 'INVALID_PHONE' }, { status: 400 });
    }

    await Promise.all([
      consumeBusinessQuota('profile.update', context.user.id),
      consumeCoarseQuota('profile.update', requestSecurityMetadata(request).ipHash),
    ]);
    const response = await (
      createAdminClient() as unknown as TrustedProfileSubmissionRpcClient
    ).rpc('submit_profile_for_approval_from_trusted_server', {
      p_user_id: context.user.id,
      p_name: parsed.data.name,
      p_surname: parsed.data.surname,
      p_job: parsed.data.job,
      p_organization: parsed.data.organization,
      p_phone_country_iso2: phone?.countryIso2 ?? null,
      p_phone_e164: phone?.phoneE164 ?? null,
    });
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
