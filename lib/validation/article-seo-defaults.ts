import type { AppLocale } from '../../i18n/config.ts';
import { CONTENT_SEO_LIMITS, type ContentSeo } from './content-seo.ts';

/**
 * The article counterpart of `courseSeoDefaults`. An article without a stored
 * SEO block used to borrow the generic default, whose filler is Russian: a
 * Chinese summary is naturally under the 40-character floor, so the translated
 * page ended its meta description with a Russian sentence. Each language now
 * pads with its own wording; Russian keeps the exact text it always had, which
 * is why `defaultContentSeo` still serves it.
 */
const FALLBACK_TITLE: Record<AppLocale, string> = {
  ru: 'Материал SafetyHub',
  kk: 'SafetyHub материалы',
  en: 'SafetyHub article',
  zh: 'SafetyHub 资料',
};

const DESCRIPTION_TAIL: Record<AppLocale, string> = {
  ru: 'Практический материал SafetyHub по безопасности труда и промышленной безопасности.',
  kk: 'Еңбек қауіпсіздігі және өнеркәсіптік қауіпсіздік бойынша SafetyHub практикалық материалы.',
  en: 'A practical SafetyHub guide to occupational and industrial safety.',
  zh: 'SafetyHub 关于职业安全与工业安全的实用资料。',
};

function collapse(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

/**
 * Cut at the last whole word that fits, without «…»: a search result already
 * shortens a long title itself, and «…unauthorized D…» read as a broken page.
 * Text without spaces (Chinese) is cut at the limit.
 */
function clamp(value: string, max: number) {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  const words = lastSpace >= max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return words.replace(/[\s,;:—–-]+$/u, '');
}

/**
 * Never throws: an article with no usable title or description still gets a
 * valid block, because the page has to render something in its own language.
 */
export function articleSeoDefaults(
  locale: AppLocale,
  title: string,
  description: string,
  ogImage = '',
): ContentSeo {
  const name = collapse(title);
  const seoTitle = clamp(
    name.length >= 3 ? name : FALLBACK_TITLE[locale],
    CONTENT_SEO_LIMITS.titleMax,
  );

  const base = collapse(description);
  const withTail = base ? `${base} ${DESCRIPTION_TAIL[locale]}` : DESCRIPTION_TAIL[locale];
  const candidate = withTail.length <= CONTENT_SEO_LIMITS.descriptionMax ? withTail : base;
  const seoDescription = clamp(
    candidate.length >= 40 ? candidate : DESCRIPTION_TAIL[locale],
    CONTENT_SEO_LIMITS.descriptionMax,
  );

  return {
    title: seoTitle,
    description: seoDescription,
    ogTitle: seoTitle,
    ogDescription: seoDescription,
    ogImage,
    indexable: true,
  };
}
