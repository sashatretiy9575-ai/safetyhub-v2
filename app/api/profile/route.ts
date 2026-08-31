import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import { profileSchema } from '@/lib/validation/profile';
import { readJsonBody } from '@/lib/security/request-body';

type ProfileRpcClient = {
  rpc(
    name: 'update_profile',
    args: {
      p_name: string;
      p_surname: string;
      p_job: string;
      p_organization: string;
    },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    await requireUser({ enforceLegal: false });
    const parsed = profileSchema.safeParse(await readJsonBody(request));
    if (!parsed.success) {
      return NextResponse.json({ error: 'INVALID_PROFILE' }, { status: 400 });
    }

    const client = (await createClient()) as unknown as ProfileRpcClient;
    const response = await client.rpc('update_profile', {
      p_name: parsed.data.name,
      p_surname: parsed.data.surname,
      p_job: parsed.data.job,
      p_organization: parsed.data.organization,
    });
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
