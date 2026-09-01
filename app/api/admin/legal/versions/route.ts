import { legalVersionStageSchema } from '@/features/admin/localization-contract';
import { stageLegalLocalizationVersion } from '@/features/admin/localizations-server';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = legalVersionStageSchema.safeParse(await readJsonBody(request, 8 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(await stageLegalLocalizationVersion(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('duplicate key') || message.includes('LEGAL_VERSION_EXISTS')) {
      return NextResponse.json({ error: 'LEGAL_VERSION_EXISTS' }, { status: 409 });
    }
    return apiError(error);
  }
}
