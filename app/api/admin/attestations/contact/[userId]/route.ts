import { NextResponse } from '@/lib/security/api-response';
import * as z from 'zod';
import { apiError } from '@/server/auth/api-error';
import { requireCapability } from '@/server/auth/session';
import { createAdminClient } from '@/server/supabase/admin';

const paramsSchema = z.object({ userId: z.string().uuid() });

type SafeEmailRpcClient = {
  rpc(
    name: 'get_safe_user_email',
    args: { p_user_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * How to reach one learner: the address and the phone from their profile.
 * The employee card asks for this the moment it opens, for every row — a
 * retained certificate for a deleted course included — so it is separate
 * from the certificate history, which needs a live course revision.
 */
export async function GET(_request: Request, context: { params: Promise<{ userId: string }> }) {
  try {
    await requireCapability('user.read');
    const parsed = paramsSchema.safeParse(await context.params);
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    const admin = createAdminClient();
    // The address comes from `get_safe_user_email`, which applies the product's
    // own disclosure rules (a private ZH account has none to show).
    const [safeEmailResult, { data: profile, error: profileError }] = await Promise.all([
      (admin as unknown as SafeEmailRpcClient).rpc('get_safe_user_email', {
        p_user_id: parsed.data.userId,
      }),
      admin
        .from('profiles')
        .select('phone_e164, phone_country_iso2')
        .eq('id', parsed.data.userId)
        .maybeSingle(),
    ]);
    if (safeEmailResult.error) throw safeEmailResult.error;
    if (profileError) throw profileError;
    return NextResponse.json({
      email: typeof safeEmailResult.data === 'string' ? safeEmailResult.data : null,
      phoneE164: profile?.phone_e164 ?? null,
      phoneCountryIso2: profile?.phone_country_iso2 ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}
