import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { readJsonBody } from '@/lib/security/request-body';
import { invalidOriginResponse } from '@/server/http/request-origin';
import { requireCapability } from '@/server/auth/session';
import { apiError } from '@/server/auth/api-error';
import { createClient } from '@/server/supabase/server';

const schema = z.object({ batchId: z.string().uuid(), userId: z.string().uuid(), version: z.number().int().positive(), fields: z.object({ trainingReason: z.string().max(500), notes: z.string().max(500), qualificationDecision: z.string().max(500), formalExamReference: z.string().max(500).optional(), formalExamDate: z.union([z.iso.date(), z.literal('')]).optional(), formalExamResult: z.enum(['', 'passed', 'failed']).optional() }).strict() }).strict();
export async function PATCH(request: Request) {
  try {
    const invalid = invalidOriginResponse(request); if (invalid) return invalid;
    await requireCapability('site.settings.manage'); await requireCapability('results.export');
    const parsed = schema.safeParse(await readJsonBody(request, 8 * 1024));
    if (!parsed.success) return NextResponse.json({ error: 'DOCUMENT_PARTICIPANT_FIELDS_INVALID' }, { status: 400 });
    const p = parsed.data;
    if (p.fields.formalExamReference || p.fields.formalExamDate || p.fields.formalExamResult) await requireCapability('certificate.issue');
    const client = await createClient();
    const result = await client.rpc('save_document_participant_fields', { p_batch_id: p.batchId, p_user_id: p.userId, p_fields: p.fields, p_version: p.version });
    if (result.error?.code === '40001') return NextResponse.json({ error: 'DOCUMENT_BATCH_CONFLICT' }, { status: 409 });
    if (result.error) throw result.error;
    return NextResponse.json(result.data, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return apiError(error); }
}
