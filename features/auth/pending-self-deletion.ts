import 'server-only';

import { createAdminClient } from '@/lib/supabase/admin';
import { removeAvatarPrefix } from '@/lib/supabase/avatar-prefix-cleanup';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';

type SweepAdminClient = ReturnType<typeof createAdminClient> & {
  rpc(
    name: 'purge_pending_self_deletion',
    args: { p_email: string },
  ): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * Finishes a self-deletion the old staged path left half-done.
 *
 * Before September 2026 a person who deleted their account only got
 * `deletion_pending` set; the auth user survived because nothing ever ran the
 * purge worker. Signing in again with that email then verified the code and
 * failed on the first profile read, and the login screen said "try later"
 * forever. This runs before an OTP is sent, so the sign-in that follows creates
 * a brand-new account. Only accounts already marked for deletion are touched,
 * and a failure here never blocks the sign-in.
 */
export async function finishPendingSelfDeletion(email: string) {
  let admin: SweepAdminClient;
  try {
    admin = createAdminClient() as SweepAdminClient;
  } catch {
    return false;
  }
  const { data, error } = await admin.rpc('purge_pending_self_deletion', { p_email: email });
  if (error) {
    console.error('PENDING_SELF_DELETION_SWEEP_FAILED', {
      cause: safeErrorDiagnosticCode(error, 'UNKNOWN_SWEEP_ERROR'),
    });
    return false;
  }
  const result = data as { purged?: unknown; id?: unknown; status?: unknown } | null;
  if (result?.purged !== true || result.status !== 'completed' || typeof result.id !== 'string') {
    return false;
  }
  await removeAvatarPrefix(admin, result.id).catch((cleanupError: unknown) => {
    // The account is already gone; leftover bytes are the reconciler's job.
    console.error('ACCOUNT_AVATAR_PREFIX_CLEANUP_FAILED', {
      cause: safeErrorDiagnosticCode(cleanupError, 'UNKNOWN_STORAGE_CLEANUP_ERROR'),
    });
  });
  return true;
}
