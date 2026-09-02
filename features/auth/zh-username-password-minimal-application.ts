import type { AuthContext } from '@/features/auth/server';

/**
 * A freshly registered ZH username/password account intentionally has no
 * profile/contact payload. Its pending manual-review state is the onboarding
 * result, rather than a signal to send it through the ordinary profile form.
 *
 * A completed profile remains editable through the standard account surface,
 * including for a migrated ZH account. The null email is the server-redacted
 * projection reserved for a private synthetic ZH identity.
 */
export function isZhUsernamePasswordMinimalApplication(
  context: Pick<AuthContext, 'user' | 'profile' | 'approval'>,
) {
  return (
    context.user.email === null &&
    context.profile.preferred_locale === 'zh' &&
    context.profile.onboarding_completed_at === null &&
    context.approval.state !== 'profile_incomplete'
  );
}
