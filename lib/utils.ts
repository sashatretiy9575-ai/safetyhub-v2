import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { resolveSiteOrigin } from '@/lib/site-url';

const SAFETYHUB_TIME_ZONE = 'Asia/Oral';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Formatters are cached per locale. Constructing one is the expensive part of
 * `Intl`, and these functions are called once per table cell on every render.
 */
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDateTime(date: Date | string, locale = 'ru'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  let formatter = dateTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: SAFETYHUB_TIME_ZONE,
    });
    dateTimeFormatters.set(locale, formatter);
  }
  return formatter.format(d);
}

export function absoluteUrl(path: string): string {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${resolveSiteOrigin()}/`).toString();
}
