import { passwordAuthRetiredResponse } from '@/features/auth/password-auth-retired';
import { enforceApiNoStore } from '@/lib/security/api-response';

/** @deprecated Password changes are permanently unavailable. */
export function POST() {
  return enforceApiNoStore(passwordAuthRetiredResponse());
}
