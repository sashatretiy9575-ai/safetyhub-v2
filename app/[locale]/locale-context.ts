import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { isAppLocale, type AppLocale } from '@/i18n/config';

/**
 * Establishes the explicit locale for a physical, prefixed public route.
 *
 * `next-intl` can only statically render a route when its locale is known
 * before any translated child (including delegated page metadata) reads it.
 * The unprefixed root owns Russian; `/ru/*` is canonicalised by the proxy.
 */
export function setPhysicalLocale(value: string): AppLocale {
  if (!isAppLocale(value) || value === 'ru') notFound();

  setRequestLocale(value);
  return value;
}
