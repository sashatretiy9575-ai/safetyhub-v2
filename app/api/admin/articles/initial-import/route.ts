import { apiError } from '@/features/auth/api-error';
import { invalidOriginResponse } from '@/features/auth/request-origin';
import { requireCapability } from '@/features/auth/server';
import {
  importApprovedInitialArticles,
  InitialArticleImportError,
} from '@/lib/content/initial-article-import';
import { NextResponse } from '@/lib/security/api-response';
import { consumeAdminMutationQuota } from '@/lib/security/rate-limit';
import { readJsonBody } from '@/lib/security/request-body';
import { requestSecurityMetadata } from '@/lib/security/request-metadata';
import { z } from 'zod';

export const runtime = 'nodejs';

const requestSchema = z.object({ confirmation: z.string().min(1).max(160) }).strict();

export async function POST(request: Request) {
  try {
    const invalidOrigin = invalidOriginResponse(request);
    if (invalidOrigin) return invalidOrigin;
    const parsed = requestSchema.safeParse(await readJsonBody(request, 512));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireCapability('content.manage');
    await consumeAdminMutationQuota(
      'content.article.mutate',
      requestSecurityMetadata(request).ipHash,
    );
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
