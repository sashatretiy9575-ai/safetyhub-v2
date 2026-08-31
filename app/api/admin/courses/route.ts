import { NextResponse } from '@/lib/security/api-response';
import { saveTestSchema } from '@/lib/validation/admin';
import { saveTest } from '@/features/admin/server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requireCapability } from '@/features/auth/server';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = saveTestSchema.safeParse(await readJsonBody(request, 256 * 1024));
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'INVALID_COURSE', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    await requireCapability('test.manage');
    await consumeAdminMutationQuota('admin.test.mutate', requestSecurityMetadata(request).ipHash);
    const result = await saveTest(parsed.data);
    if (!result || typeof result.id !== 'string') {
      throw new Error('COURSE_MUTATION_RESULT_INVALID');
    }
    return NextResponse.json(result, { status: parsed.data.id ? 200 : 201 });
  } catch (error) {
    return apiError(error);
  }
}
