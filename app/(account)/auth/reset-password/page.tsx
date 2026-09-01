import { PasswordAuthRetiredPage } from '@/features/auth/password-auth-retired';
import { ZhUsernamePasswordRecoveryNotice } from '@/features/auth/zh-username-password-recovery-notice';
import { getLocale } from 'next-intl/server';

export default async function ResetPasswordPage() {
  return (await getLocale()) === 'zh' ? (
    <ZhUsernamePasswordRecoveryNotice />
  ) : (
    <PasswordAuthRetiredPage />
  );
}
