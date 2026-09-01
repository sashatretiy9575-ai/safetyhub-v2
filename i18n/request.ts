import { headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';
import { BUSINESS_TIME_ZONE, DEFAULT_LOCALE, isAppLocale, LOCALE_HEADER_NAME } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';

export default getRequestConfig(async () => {
  const requestHeaders = await headers();
  const candidate = requestHeaders.get(LOCALE_HEADER_NAME);
  const locale = isAppLocale(candidate) ? candidate : DEFAULT_LOCALE;

  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: BUSINESS_TIME_ZONE,
  };
});
