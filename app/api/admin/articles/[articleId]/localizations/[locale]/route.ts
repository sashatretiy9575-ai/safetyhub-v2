import * as z from 'zod';
import { saveArticleLocalization } from '@/server/admin/localizations';
import {
  translatedLocaleSchema,
  articleLocalizationDraftSchema,
} from '@/lib/admin/localization-contract';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const paramsSchema = z.object({
  articleId: z.string().uuid(),
  locale: translatedLocaleSchema,
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
