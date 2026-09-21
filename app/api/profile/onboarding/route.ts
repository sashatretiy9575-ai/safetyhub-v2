import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { requireUser } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';
import { unwrapRpcMutationResponse } from '@/server/supabase/rpc-mutation-result';
import { onboardingProfileSchema } from '@/lib/validation/profile';
import { readJsonBody } from '@/lib/security/request-body';
import { normalizeUserPhone } from '@/server/phone';
import { phoneRequiredForLocale } from '@/lib/profile/fields';
import { consumeBusinessQuota, consumeCoarseQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { requestCourseAccess } from '@/server/learning/course-access-request';

/** The courses the newcomer clicked before signing up, remembered by the browser. */
function requestedCourseSlugs(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('courseSlugs' in body)) return [];
  const value = (body as { courseSlugs?: unknown }).courseSlugs;
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((slug): slug is string => typeof slug === 'string'))].slice(0, 5);
}

type TrustedProfileSubmissionRpcClient = {
  rpc: (
    name: 'submit_profile_for_approval_from_trusted_server_with_education',
    args: {
      p_user_id: string;
      p_name: string;
      p_surname: string;
      p_job: string;
      p_organization: string;
      p_education: string;
      p_phone_country_iso2: string | null;
      p_phone_e164: string | null;
    },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    const context = await requireUser();
    const body = await readJsonBody(request);
    const parsed = onboardingProfileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_PROFILE' }, { status: 400 });
    }
    // Everyone but a Chinese account has to leave a number, and a number that
    // does not parse is refused from anyone.
    const phone = parsed.data.phone.nationalNumber ? normalizeUserPhone(parsed.data.phone) : null;
    if (
      (parsed.data.phone.nationalNumber && !phone) ||
      (!phone && phoneRequiredForLocale(context.profile.preferred_locale))
    ) {
      return NextResponse.json({ error: 'INVALID_PHONE' }, { status: 400 });
    }

    if (!context.profile.avatar_updated_at) {
      return NextResponse.json({ error: 'AVATAR_REQUIRED' }, { status: 409 });
    }

    await Promise.all([
      consumeBusinessQuota('profile.update', context.user.id),
      consumeCoarseQuota('profile.update', requestSecurityMetadata(request).ipHash),
    ]);
    // Before the submission, so the application that reaches the administrator
    // already names these courses. A course that cannot be recorded never
    // costs the person their application.
    for (const slug of requestedCourseSlugs(body)) {
      await requestCourseAccess(context.user.id, slug).catch(() => undefined);
    }
    const response = await (
      createAdminClient() as unknown as TrustedProfileSubmissionRpcClient
    ).rpc('submit_profile_for_approval_from_trusted_server_with_education', {
      p_user_id: context.user.id,
      p_name: parsed.data.name,
      p_surname: parsed.data.surname,
      p_job: parsed.data.job,
      p_organization: parsed.data.organization,
      p_education: parsed.data.education,
      p_phone_country_iso2: phone?.countryIso2 ?? null,
      p_phone_e164: phone?.phoneE164 ?? null,
    });
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
