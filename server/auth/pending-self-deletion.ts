import 'server-only';

import { createAdminClient } from '@/server/supabase/admin';
import { removeAvatarPrefix } from '@/server/supabase/avatar-prefix-cleanup';
import { safeErrorDiagnosticCode } from '@/lib/security/error-diagnostics';

/**
 * Finishes the storage side of a self-deletion the old staged path left
 * half-done.
 *
 * Before September 2026 a person who deleted their account only got
 * `deletion_pending` set; the auth user survived because nothing ever ran the
 * purge worker. Signing in again with that email then verified the code and
 * failed on the first profile read, and the login screen said "try later"
 * forever. The database side of the sweep now runs inside
 * `begin_email_otp_request`, before an OTP is sent, so the sign-in that
 * follows creates a brand-new account. Only the leftover avatar bytes are
 * swept here, best-effort: the account is already gone, and a failure never
 * blocks the sign-in.
 */
export async function sweepPurgedAccountStorage(userId: string) {
  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch {
    return false;
  }
  await removeAvatarPrefix(admin, userId).catch((cleanupError: unknown) => {
    // Leftover bytes are the reconciler's job.
    console.error('ACCOUNT_AVATAR_PREFIX_CLEANUP_FAILED', {
      cause: safeErrorDiagnosticCode(cleanupError, 'UNKNOWN_STORAGE_CLEANUP_ERROR'),
    });
  });
  return true;
}
