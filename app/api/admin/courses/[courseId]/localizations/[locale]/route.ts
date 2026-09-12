import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import {
  translatedLocaleSchema,
  courseLocalizationDraftSchema,
} from '@/lib/admin/localization-contract';
import { saveCourseLocalization } from '@/server/admin/localizations';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const paramsSchema = z.object({
  courseId: z.string().uuid(),
  locale: translatedLocaleSchema,
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ courseId: string; locale: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      courseLocalizationDraftSchema.safeParseAsync(await readJsonBody(request, 768 * 1024)),
    ]);
    if (!params.success || !body.success || params.data.locale !== body.data.locale) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    return NextResponse.json(await saveCourseLocalization(params.data.courseId, body.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('COURSE_LOCALIZATION_ASSESSMENT_REQUIRED')) {
      return NextResponse.json(
        { error: 'COURSE_LOCALIZATION_ASSESSMENT_REQUIRED' },
        { status: 409 },
      );
    }
    if (message.includes('COURSE_LOCALIZATION_CONFLICT')) {
      return NextResponse.json({ error: 'COURSE_LOCALIZATION_CONFLICT' }, { status: 409 });
    }
    return apiError(error);
  }
}
