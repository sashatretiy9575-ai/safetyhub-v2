import { redirect } from 'next/navigation';
import { localizePathname, type AppLocale } from '@/i18n/config';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';

export default async function RegisterPage() {
  const locale = (await getPrivateRequestLocale()) as AppLocale;
  // Keep historic links working without presenting a second, contradictory
  // registration route. The canonical access screen owns both outcomes.
  redirect(localizePathname('/auth/login', locale));
}
