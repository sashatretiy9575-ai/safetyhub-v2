import { legalVersionStageSchema } from '@/lib/admin/localization-contract';
import { stageLegalLocalizationVersion } from '@/server/admin/localizations';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = legalVersionStageSchema.safeParse(await readJsonBody(request, 8 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(await stageLegalLocalizationVersion(parsed.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('duplicate key') || message.includes('LEGAL_VERSION_EXISTS')) {
      return NextResponse.json({ error: 'LEGAL_VERSION_EXISTS' }, { status: 409 });
    }
    return apiError(error);
  }
}
