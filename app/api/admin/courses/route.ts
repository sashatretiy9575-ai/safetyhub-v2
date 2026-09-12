import { NextResponse } from '@/lib/security/api-response';
import { saveTestSchema } from '@/lib/validation/admin';
import { saveTest } from '@/server/admin/management';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requireCapability } from '@/server/auth/session';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const parsed = saveTestSchema.safeParse(await readJsonBody(request, 512 * 1024));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'INVALID_COURSE', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const result = await saveTest(parsed.data);
    if (!result || typeof result.id !== 'string') {
      throw new Error('COURSE_MUTATION_RESULT_INVALID');
    }
    return NextResponse.json(result, { status: parsed.data.id ? 200 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
