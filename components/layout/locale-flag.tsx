/* eslint-disable @next/next/no-img-element */

import cnFlag from 'flag-icons/flags/4x3/cn.svg';
import gbFlag from 'flag-icons/flags/4x3/gb.svg';
import kzFlag from 'flag-icons/flags/4x3/kz.svg';
import ruFlag from 'flag-icons/flags/4x3/ru.svg';
import { cn } from '@/lib/utils';
import type { AppLocale } from '@/i18n/config';

const FLAG_ASSET = {
  ru: ruFlag,
  kk: kzFlag,
  en: gbFlag,
  zh: cnFlag,
} as const;

function flagSource(asset: (typeof FLAG_ASSET)[AppLocale]) {
  // Next emits static SVG imports as URL strings in the production client
  // bundle. Other build modes may expose a StaticImageData-shaped object.
  // Supporting both keeps the flag real and visible across the two paths.
  return typeof asset === 'string' ? asset : asset.src;
}

/**
 * Flag Icons ships the source SVGs in the local production build under its MIT
 * license.  The adjacent language name is always the accessible label; this
 * image is deliberately decorative rather than an emoji substitute.
 */
export function LocaleFlag({
  locale,
  className,
}: {
  locale: AppLocale;
  className?: string;
}) {
  return (
    // Native SVGs are already content-addressed by the Next static-asset
    // pipeline, so an image optimizer round-trip would only add latency.
    <img
      src={flagSource(FLAG_ASSET[locale])}
      alt=""
      aria-hidden="true"
      width={22}
      height={16}
      className={cn(
        'h-4 w-[22px] shrink-0 rounded-[3px] border border-black/15 object-cover shadow-[0_1px_1px_rgb(0_0_0/0.12)]',
        className,
      )}
    />
  );
}
