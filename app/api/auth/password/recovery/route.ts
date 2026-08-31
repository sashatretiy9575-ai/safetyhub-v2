import { passwordAuthRetiredResponse } from '@/features/auth/password-auth-retired';
import { enforceApiNoStore } from '@/lib/security/api-response';

/** @deprecated Password recovery is permanently unavailable. */
export function POST() {
  return enforceApiNoStore(passwordAuthRetiredResponse());
}
