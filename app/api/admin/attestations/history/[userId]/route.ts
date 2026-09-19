import { NextResponse } from '@/lib/security/api-response';
import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';

const paramsSchema = z.object({
  userId: z.string().uuid(),
  testId: z.string().uuid(),
  testVersion: z.coerce.number().int().positive(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ userId: string }> },
) {
  try {
    await requireCapability('certificate.read');
    await requireCapability('user.read');
    const url = new URL(request.url);
    const parsed = paramsSchema.safeParse({
      userId: (await context.params).userId,
      testId: url.searchParams.get('testId'),
      testVersion: url.searchParams.get('testVersion'),
    });
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const admin = createAdminClient();
    // Certificates only. The card asks the contact endpoint how to reach the
    // person, so the address lookup that used to ride along here returned a
    // value nothing read, and its failure took the whole history down with it.
    const { data: revision, error: revisionError } = await admin
      .from('test_revisions')
      .select('id')
      .eq('test_id', parsed.data.testId)
      .eq('version', parsed.data.testVersion)
      .maybeSingle();
    if (revisionError) throw revisionError;
    if (!revision) return NextResponse.json({ items: [] });

    const { data, error } = await admin
      .from('certificates')
      .select('id,certificate_number,score,total,issued_at,revoked_at,revoke_reason')
      .eq('user_id', parsed.data.userId)
      .eq('revision_id', revision.id)
      .order('issued_at', { ascending: false })
      .limit(25);
    if (error) throw error;
    return NextResponse.json({
      items: (data ?? []).map((certificate) => ({
        id: certificate.id,
        certificateNumber: certificate.certificate_number,
        score: certificate.score,
        total: certificate.total,
        issuedAt: certificate.issued_at,
        revokedAt: certificate.revoked_at,
        revokeReason: certificate.revoke_reason,
      })),
    });
  } catch (error) {
    return apiError(error);
  }
}
