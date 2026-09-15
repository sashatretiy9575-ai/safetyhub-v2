import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { readJsonBody } from '@/lib/security/request-body';
import { documentBatchSchema, readDocumentEditor, saveDocumentBatch } from '@/server/certificates/document-editor';
import { consumeAdminMutationQuota } from '@/server/security/rate-limit';
import { requestSecurityMetadata } from '@/server/security/request-metadata';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const organization = params.get('organization') ?? '';
    const course = params.get('course') ?? '';
    if (organization.length > 200 || course.length > 160) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json(await readDocumentEditor(organization, course), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
export async function PATCH(request: Request) {
  try {
    const invalid = invalidOriginResponse(request);
    if (invalid) return invalid;
    await requireCapability('site.settings.manage');
    await requireCapability('results.export');
    await consumeAdminMutationQuota('site.settings.update', requestSecurityMetadata(request).ipHash);
    const input = documentBatchSchema.safeParse(await readJsonBody(request, 4096));
    if (!input.success) return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    return NextResponse.json({ batch: await saveDocumentBatch(input.data) });
  } catch (error) {
    if (error && typeof error === 'object' && 'message' in error && String(error.message).includes('DOCUMENT_BATCH_CONFLICT')) {
      return NextResponse.json({ error: 'DOCUMENT_BATCH_CONFLICT' }, { status: 409 });
    }
    return apiError(error);
  }
}
