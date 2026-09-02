import type messages from '@/messages/ru.json';
import type { AppLocale } from '@/i18n/config';

declare module 'next-intl' {
  interface AppConfig {
    Locale: AppLocale;
    Messages: typeof messages;
  }
}

declare module 'flag-icons/flags/4x3/*.svg' {
  const content: string;
  export default content;
}
