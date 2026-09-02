import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import {
  legalLocalizationDraftSchema,
} from '@/features/admin/localization-contract';
import {
  saveLegalLocalization,
} from '@/features/admin/localizations-server';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

export async function PUT(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = legalLocalizationDraftSchema.safeParse(await readJsonBody(request, 320 * 1024));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(await saveLegalLocalization(parsed.data));
  } catch (error) {
    return apiError(error);
  }
}
