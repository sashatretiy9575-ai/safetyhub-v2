import type { AppLocale } from '@/i18n/config';
import { localizePathname } from '@/i18n/config';

export type EmailOtpLocale = Exclude<AppLocale, 'zh'>;


/** The three locale markers are fixed application-owned destinations. */
export function emailOtpRedirectUrl(origin: string, locale: EmailOtpLocale) {
  const url = new URL(localizePathname('/auth/login', locale), origin);
  url.searchParams.set('email_locale', locale);
  return url.toString();
}

export function localizedAccountPath(pathname: string, locale: AppLocale) {
  return pathname === '/admin' ? pathname : localizePathname(pathname, locale);
}
