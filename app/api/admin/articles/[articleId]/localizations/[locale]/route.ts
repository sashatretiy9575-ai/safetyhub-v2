import { z } from 'zod';
import { saveArticleLocalization } from '@/features/admin/localizations-server';
import {
  appLocaleSchema,
  articleLocalizationDraftSchema,
} from '@/features/admin/localization-contract';
import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';

const paramsSchema = z.object({
  articleId: z.string().uuid(),
  locale: appLocaleSchema.exclude(['ru']),
});

export async function PUT(
  request: Request,
  context: { params: Promise<{ articleId: string; locale: string }> },
) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      articleLocalizationDraftSchema.safeParseAsync(await readJsonBody(request, 512 * 1024)),
    ]);
    if (!params.success || !body.success || params.data.locale !== body.data.locale) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(await saveArticleLocalization(params.data.articleId, body.data));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('ARTICLE_LOCALIZATION_CONFLICT')) {
      return NextResponse.json({ error: 'ARTICLE_LOCALIZATION_CONFLICT' }, { status: 409 });
    }
    return apiError(error);
  }
}
