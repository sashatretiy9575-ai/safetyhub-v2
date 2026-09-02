import { PasswordAuthRetiredPage } from '@/features/auth/password-auth-retired';
import { ZhUsernamePasswordRecoveryNotice } from '@/features/auth/zh-username-password-recovery-notice';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';

export default async function ResetPasswordPage() {
  return (await getPrivateRequestLocale()) === 'zh' ? (
    <ZhUsernamePasswordRecoveryNotice />
  ) : (
    <PasswordAuthRetiredPage />
  );
}
