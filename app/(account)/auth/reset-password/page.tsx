import { PasswordAuthRetiredPage } from '@/components/auth/password-auth-retired-page';
import { ZhUsernamePasswordRecoveryNotice } from '@/components/auth/zh-username-password-recovery-notice';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';

export default async function ResetPasswordPage() {
  return (await getPrivateRequestLocale()) === 'zh' ? (
    <ZhUsernamePasswordRecoveryNotice />
  ) : (
    <PasswordAuthRetiredPage />
  );
}
