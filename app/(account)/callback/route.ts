import { redirectFromRetiredPasswordLink } from '@/features/auth/password-auth-retired';

/**
 * Legacy email-confirmation, recovery, and invite links are intentionally
 * discarded. Email OTP authentication never exchanges a callback code.
 */
export function GET() {
  return redirectFromRetiredPasswordLink();
}
