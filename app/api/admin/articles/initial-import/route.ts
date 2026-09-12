import { apiError } from '@/server/auth/api-error';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import {
  importApprovedInitialArticles,
  InitialArticleImportError,
} from '@/server/content/initial-article-import';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/server/security/request-metadata';
import * as z from 'zod';

export const runtime = 'nodejs';

const requestSchema = z.object({ confirmation: z.string().min(1).max(160) }).strict();

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
    const parsed = requestSchema.safeParse(await readJsonBody(request, 512));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    return NextResponse.json(await importApprovedInitialArticles(parsed.data.confirmation), {
      status: 201,
    });
  } catch (error) {
    if (error instanceof InitialArticleImportError) {
      return NextResponse.json({ error: error.code }, { status: error.status });
    }
    return apiError(error);
  }
}
