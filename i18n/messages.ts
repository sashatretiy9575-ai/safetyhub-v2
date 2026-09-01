import type { AbstractIntlMessages } from 'next-intl';
import type { AppLocale } from '@/i18n/config';

const MESSAGE_LOADERS = {
  ru: () => import('@/messages/ru.json').then((module) => module.default),
  kk: () => import('@/messages/kk.json').then((module) => module.default),
  en: () => import('@/messages/en.json').then((module) => module.default),
  zh: () => import('@/messages/zh.json').then((module) => module.default),
} as const satisfies Record<AppLocale, () => Promise<AbstractIntlMessages>>;

export function loadMessages(locale: AppLocale) {
  return MESSAGE_LOADERS[locale]();
}
