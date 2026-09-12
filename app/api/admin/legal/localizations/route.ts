import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import {
  legalLocalizationDraftSchema,
} from '@/lib/admin/localization-contract';
import {
  saveLegalLocalization,
} from '@/server/admin/localizations';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = legalLocalizationDraftSchema.safeParse(await readJsonBody(request, 320 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(await saveLegalLocalization(parsed.data));
  } catch (error) {
    return apiError(error);
  }
}
