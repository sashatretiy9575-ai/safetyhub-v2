import { z } from 'zod';
import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { readJsonBody } from '@/lib/security/request-body';

const requestSchema = z.object({ locale: z.enum(['ru', 'kk', 'en', 'zh']) }).strict();

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'INVALID_ORIGIN' }, { status: 403 });
    }
    const parsed = requestSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 });
    }
    await requireUser({ enforceLegal: false });
    const supabase = await createClient();
    const [{ error: profileError }, { error: metadataError }] = await Promise.all([
      supabase.rpc('set_preferred_locale', { p_locale: parsed.data.locale }),
      supabase.auth.updateUser({ data: { preferred_locale: parsed.data.locale } }),
    ]);
    if (profileError || metadataError) {
      return NextResponse.json({ error: 'LOCALE_SYNC_UNAVAILABLE' }, { status: 503 });
    }
    return NextResponse.json({ updated: true });
  } catch (error) {
    return apiError(error);
  }
}
