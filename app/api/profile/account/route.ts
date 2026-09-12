import { NextResponse } from '@/lib/security/api-response';
import type { NextRequest } from 'next/server';
import { apiError } from '@/server/auth/api-error';
import { isSameOriginRequest } from '@/server/http/request-origin';
import { requireAccountDeletionUser } from '@/server/auth/session';
import { invalidateCertificateVerificationCache } from '@/server/certificates/issuance';
import { createAdminClient } from '@/server/supabase/admin';
import { removeAvatarPrefix } from '@/server/supabase/avatar-prefix-cleanup';
import { clearSafetyHubLocalSession } from '@/lib/supabase/session-cleanup';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';
import { readJsonBody } from '@/lib/security/request-body';

// Language-neutral protocol value. The localized phrase typed by the user is
// validated in the UI and is never used as an API contract.
const CONFIRMATION = 'DELETE_ACCOUNT';

type PurgeAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'self_purge_user_account',
    args: { p_target_id: string },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

type PurgeOutcome = { status: 'completed' } | { status: 'skipped'; reason: string };

function purgeOutcome(value: unknown, userId: string): PurgeOutcome {
  const result = value as Record<string, unknown> | null;
  if (!result || result.id !== userId) throw new Error('ACCOUNT_PURGE_CONTRACT_INVALID');
  if (result.status === 'completed') return { status: 'completed' };
  if (result.status === 'skipped' && typeof result.reason === 'string') {
    return { status: 'skipped', reason: result.reason };
  }
  throw new Error('ACCOUNT_PURGE_CONTRACT_INVALID');
}

/**
 * Deletes the caller's own account inside this request.
 *
 * The staged path (`begin_user_account_purge` plus the reconciler) only ever
 * marked the account: nothing ran the purge, the auth user survived, and a
 * later sign-in with the same email verified the code and then failed on the
 * first profile read. The owner's decision is that a self-deletion removes
 * everything at once and a new sign-in starts a brand-new account.
 */
export async function DELETE(request: NextRequest) {
  try {
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: 'FORBIDDEN' }, { status: 403 });
    }
    // The deletion-only guard lets an owner whose earlier attempt failed after
    // `deletion_pending` was set retry the purge.
    const context = await requireAccountDeletionUser();
    const body = (await readJsonBody(request)) as { confirmation?: unknown } | null;
    if (body?.confirmation !== CONFIRMATION) {
      return NextResponse.json({ error: 'CONFIRMATION_MISMATCH' }, { status: 400 });
    }

    const admin = createAdminClient() as PurgeAdminClient;
    const { data, error: purgeError } = await admin.rpc('self_purge_user_account', {
      p_target_id: context.user.id,
    });
    if (purgeError) {
      if (purgeError.message === 'LAST_ACTIVE_ADMIN_PROTECTED') {
        return NextResponse.json({ error: 'LAST_ACTIVE_ADMIN_PROTECTED' }, { status: 409 });
      }
      throw purgeError;
    }
    const outcome = purgeOutcome(data, context.user.id);
    invalidateCertificateVerificationCache();
    if (outcome.status === 'skipped') {
      // An Auth operation is still in flight for this account (an invite, a
      // suspension) or it holds an import receipt. The account is untouched;
      // the owner is told to try again or to ask an administrator.
      const busy = outcome.reason === 'ACCOUNT_HAS_PENDING_AUTH_OPERATIONS';
      return NextResponse.json(
        { error: busy ? 'ACCOUNT_BUSY' : 'ACCOUNT_DELETION_BLOCKED' },
        { status: 409 },
      );
    }

    // The database transaction has committed; the bytes in Storage are not
    // part of it. Best effort here, the reconciler sweeps what is left.
    await removeAvatarPrefix(admin, context.user.id).catch((cleanupError: unknown) => {
      console.error('ACCOUNT_AVATAR_PREFIX_CLEANUP_FAILED', {
        cause: safeErrorDiagnosticCode(cleanupError, 'UNKNOWN_STORAGE_CLEANUP_ERROR'),
      });
    });
    const response = NextResponse.json({ deleted: true }, { status: 200 });
    return clearSafetyHubLocalSession(request, response);
  } catch (error) {
    return apiError(error);
  }
}
