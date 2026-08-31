import { passwordAuthRetiredResponse } from '@/features/auth/password-auth-retired';
import { enforceApiNoStore } from '@/lib/security/api-response';

/** @deprecated Password registration is permanently replaced by email OTP. */
export function POST() {
  return enforceApiNoStore(passwordAuthRetiredResponse());
}
