import type { AppLocale } from '@/i18n/config';
import { CONTENT_SEO_LIMITS, type ContentSeo } from './content-seo.ts';

/**
 * Courses were created before SEO was collected, so every course carried an
 * empty `seo` object: the editor showed five blank fields, publication was
 * refused, and the public pages fell back to a bare one-word title in every
 * language. These defaults give each course a real title and description in its
 * own language, built from the course's own published wording rather than from
 * a translation, so an administrator starts from something usable and edits it
 * instead of inventing it.
 */
const TITLE_SUFFIX: Record<AppLocale, string> = {
  ru: 'онлайн-обучение и аттестация',
  kk: 'онлайн оқыту және аттестаттау',
  en: 'online training and certification',
  zh: '在线培训与考核',
};

const DESCRIPTION_TAIL: Record<AppLocale, string> = {
  ru: 'Онлайн-курс, тест и сертификат SafetyHub.',
  kk: 'SafetyHub онлайн курсы, тесті және сертификаты.',
  en: 'SafetyHub online course, test and certificate.',
  zh: 'SafetyHub 在线课程、测试与证书。',
};

const FALLBACK_DESCRIPTION: Record<AppLocale, string> = {
  ru: 'Практический курс SafetyHub по охране труда и промышленной безопасности с тестом и сертификатом.',
  kk: 'Еңбекті қорғау және өнеркәсіптік қауіпсіздік бойынша SafetyHub практикалық курсы: тест және сертификат.',
  en: 'A practical SafetyHub course on occupational and industrial safety, with a test and a certificate.',
  // The minimum length is counted in characters, and Chinese is dense enough
  // that a natural one-line summary falls under it.
  zh: 'SafetyHub 提供的职业安全、工业安全与消防安全实用在线课程，面向员工与团队，包含知识测试与结业证书。',
};

function collapse(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

/**
 * Some course names were stored in lower case — the Kazakh and English
 * fire-safety course among them — and a page title that opens lower case reads
 * as a mistake in search results. Only the first character is touched, so an
 * acronym like BIOT and a Chinese name are left exactly as they are.
 */
function capitalize(value: string, locale: AppLocale) {
  const first = value.slice(0, 1);
  const upper = first.toLocaleUpperCase(locale === 'zh' ? 'zh-Hans' : locale);
  return upper === first ? value : `${upper}${value.slice(1)}`;
}

function clamp(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Builds the SEO block a course would have been given had the field existed when
 * it was created. Never throws: a course with no usable title or description
 * still gets a valid block, because the alternative is the blank form that
 * blocked publication with nothing to look at.
 */
export function courseSeoDefaults(
  locale: AppLocale,
  title: string,
  description: string,
  ogImage = '',
): ContentSeo {
  const name = capitalize(collapse(title), locale);
  const suffixed = name ? `${name} — ${TITLE_SUFFIX[locale]}` : TITLE_SUFFIX[locale];
  const seoTitle = clamp(
    suffixed.length <= CONTENT_SEO_LIMITS.titleMax ? suffixed : name || TITLE_SUFFIX[locale],
    CONTENT_SEO_LIMITS.titleMax,
  );

  const base = collapse(description);
  const withTail = base ? `${base} ${DESCRIPTION_TAIL[locale]}` : FALLBACK_DESCRIPTION[locale];
  const candidate = withTail.length <= CONTENT_SEO_LIMITS.descriptionMax ? withTail : base;
  const seoDescription = clamp(
    candidate.length >= 40 ? candidate : FALLBACK_DESCRIPTION[locale],
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

/**
 * Keeps whatever the course already stores and fills only what is missing, so a
 * hand-written SEO block is never replaced by a generated one.
 */
export function withCourseSeoDefaults(
  locale: AppLocale,
  title: string,
  description: string,
  stored: Partial<ContentSeo> | null | undefined,
): ContentSeo {
  const defaults = courseSeoDefaults(locale, title, description, stored?.ogImage ?? '');
  const present = Object.fromEntries(
    Object.entries(stored ?? {}).filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    ),
  );
  return { ...defaults, ...present, indexable: stored?.indexable !== false };
}
