import { NextResponse } from '@/lib/security/api-response';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireUser } from '@/features/auth/server';
import { PRIVACY_POLICY, TERMS_POLICY } from '@/lib/legal';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';

type LegalRpcClient = {
  rpc(
    name: 'accept_current_legal_documents',
    args: {
      p_privacy_version: string;
      p_privacy_body_revision: string;
      p_terms_version: string;
      p_terms_body_revision: string;
    },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export async function POST(request: Request) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    await requireUser({ enforceLegal: false });
    const client = (await createClient()) as unknown as LegalRpcClient;
    const response = await client.rpc('accept_current_legal_documents', {
      p_privacy_version: PRIVACY_POLICY.version,
      p_privacy_body_revision: PRIVACY_POLICY.bodyRevision,
      p_terms_version: TERMS_POLICY.version,
      p_terms_body_revision: TERMS_POLICY.bodyRevision,
    });
    return NextResponse.json(unwrapRpcMutationResponse(response));
  } catch (error) {
    return apiError(error);
  }
}
