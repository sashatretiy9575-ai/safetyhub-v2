import { NextResponse } from '@/lib/security/api-response';
import type { NextRequest } from 'next/server';
import { apiError } from '@/features/auth/api-error';
import { isSameOriginRequest } from '@/features/auth/request-origin';
import { requireAccountDeletionUser } from '@/features/auth/server';
import { invalidateCertificateVerificationCache } from '@/features/certificates/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { clearSafetyHubLocalSession } from '@/lib/supabase/session-cleanup';
import { readJsonBody } from '@/lib/security/request-body';

// Language-neutral protocol value. The localized phrase typed by the user is
// validated in the UI and is never used as an API contract.
const CONFIRMATION = 'DELETE_ACCOUNT';

type PurgeAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'begin_user_account_purge',
    args: { p_target_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

function pendingPurge(value: unknown, userId: string) {
  const result = value as Record<string, unknown> | null;
  if (
    !result ||
    result.userId !== userId ||
    result.exists !== true ||
    result.pending !== true ||
    typeof result.tombstoneId !== 'string' ||
    typeof result.state !== 'string' ||
    typeof result.cleanupNotBefore !== 'string'
  ) {
    throw new Error('ACCOUNT_PURGE_CONTRACT_INVALID');
  }
  return {
    pending: true,
    state: result.state,
    cleanupNotBefore: result.cleanupNotBefore,
  };
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    // This deletion-only guard permits an authenticated owner to resume after
    // begin_user_account_purge set deletion_pending and a later step failed.
    const context = await requireAccountDeletionUser();
    const body = (await readJsonBody(request)) as { confirmation?: unknown } | null;
    if (body?.confirmation !== CONFIRMATION) {
      return NextResponse.json({ error: 'CONFIRMATION_MISMATCH' }, { status: 400 });
    }

    const admin = createAdminClient() as PurgeAdminClient;
    const { data, error: beginError } = await admin.rpc('begin_user_account_purge', {
      p_target_id: context.user.id,
    });
    if (beginError) throw beginError;
    const pending = pendingPurge(data, context.user.id);
    invalidateCertificateVerificationCache();
    const response = NextResponse.json(pending, { status: 202 });
    return clearSafetyHubLocalSession(request, response);
  } catch (error) {
    return apiError(error);
  }
}
