import * as z from 'zod';
import { publishArticleLocalizations } from '@/server/admin/localizations';
import { localizedPublicationSchema } from '@/lib/admin/localization-contract';
import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

const paramsSchema = z.object({ articleId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ articleId: string }> }) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const [params, body] = await Promise.all([
      paramsSchema.safeParseAsync(await context.params),
      localizedPublicationSchema.safeParseAsync(await readJsonBody(request, 2 * 1024)),
    ]);
    if (!params.success || !body.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    return NextResponse.json(
      await publishArticleLocalizations(params.data.articleId, body.data.expectedContentHash),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('ARTICLE_LOCALIZATIONS_INCOMPLETE')) {
      return NextResponse.json({ error: 'ARTICLE_LOCALIZATIONS_INCOMPLETE' }, { status: 409 });
    }
    return apiError(error);
  }
}
