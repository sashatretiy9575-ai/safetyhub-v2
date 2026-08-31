import { NextResponse } from '@/lib/security/api-response';
import { z } from 'zod';
import { apiError } from '@/features/auth/api-error';
import { requireCapability } from '@/features/auth/server';
import { createAdminClient } from '@/lib/supabase/admin';

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
    const [{ data: revision, error: revisionError }, authResult] = await Promise.all([
      admin
        .from('test_revisions')
        .select('id')
        .eq('test_id', parsed.data.testId)
        .eq('version', parsed.data.testVersion)
        .maybeSingle(),
      admin.auth.admin.getUserById(parsed.data.userId),
    ]);
    if (revisionError) throw revisionError;
    if (authResult.error) throw authResult.error;
    const email = authResult.data.user?.email ?? null;
    if (!revision) return NextResponse.json({ email, items: [] });

    const { data, error } = await admin
      .from('certificates')
      .select('*')
      .eq('user_id', parsed.data.userId)
      .eq('revision_id', revision.id)
      .order('issued_at', { ascending: false })
      .limit(25);
    if (error) throw error;
    return NextResponse.json({
      email,
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
