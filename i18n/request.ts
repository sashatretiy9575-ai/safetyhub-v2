import { getRequestConfig } from 'next-intl/server';
import { BUSINESS_TIME_ZONE, DEFAULT_LOCALE, isAppLocale } from '@/i18n/config';
import { loadMessages } from '@/i18n/messages';

export default getRequestConfig(async ({ requestLocale }) => {
  // Locale is supplied explicitly by the closest route layout through
  // `setRequestLocale`.  Reading request headers here would turn otherwise
  // static public pages into request-time renders and make their HTML depend
  // on cookies/Accept-Language at the CDN edge.
  const candidate = await requestLocale;
  const locale = isAppLocale(candidate) ? candidate : DEFAULT_LOCALE;

  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: BUSINESS_TIME_ZONE,
  };
});
