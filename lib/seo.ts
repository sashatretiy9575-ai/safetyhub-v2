import type { Metadata } from 'next';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  htmlLanguage,
  localeAlternates,
  localizePathname,
  openGraphLocale,
  type AppLocale,
} from '@/i18n/config';
import { absoluteUrl } from './utils';
import { BRAND } from './constants';
import { isPreviewDeployment } from './site-url';
import type { SiteContactSettings } from './site-contacts-shared';
import { rolloutFeatureEnabled } from './release/rollout-flags';

type SeoOptions = {
  title?: string;
  description?: string;
  path?: string;
  ogImage?: string;
  ogTitle?: string;
  ogDescription?: string;
  noindex?: boolean;
  keywords?: string[];
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
  type?: 'website' | 'article';
  locale?: AppLocale;
  /**
   * The locales this particular document exists in. Defaults to all of them,
   * which is right for the static shell and wrong for anything published per
   * locale — a legal revision that only ever had a Russian text was still
   * advertising kk, en and zh alternates.
   */
  availableLocales?: readonly AppLocale[];
};

/**
 * The city, written the way each locale writes it. `BRAND.city` is Cyrillic, so
 * the geo meta tag and the postal address in the organisation JSON-LD used to
 * say «Алматы» on the English and Chinese pages as well.
 */
const LOCALIZED_CITY: Record<AppLocale, string> = {
  ru: 'Алматы',
  kk: 'Алматы',
  en: 'Almaty',
  zh: '阿拉木图',
};

const HREFLANG_BY_LOCALE = {
  ru: 'ru-KZ',
  kk: 'kk-KZ',
  en: 'en',
  zh: 'zh-Hans',
} as const satisfies Record<AppLocale, string>;

/** What a search result actually shows before it truncates. */
const TITLE_BUDGET = 60;

/**
 * One identity for the organisation across every page and every locale.
 *
 * The organisation appeared as three unlinked nodes — EducationalOrganization,
 * the Article publisher and the course provider — and the LocalBusiness `@id`
 * changed with the locale, so one company looked like four.
 *
 * Computed rather than declared at module scope: `absoluteUrl` resolves the
 * deployment origin and throws when it cannot, which at module scope would move
 * that failure to import time and freeze the origin into the module.
 */
const organizationId = () => absoluteUrl('/#organization');

export const BASE_KEYWORDS = [
  'промышленная безопасность Алматы',
  'обучение охране труда Казахстан',
  'аттестация по промбезопасности РК',
  'пожарно-технический минимум Алматы',
  'онлайн курсы охрана труда',
  'сертификат БиОТ Казахстан',
  'обучение специалистов ОПО',
  'safetyhub.kz',
  'охрана труда онлайн',
  'аттестация инженеров Алматы',
];

export function buildMetadata({
  title,
  description,
  path = '',
  ogImage = '/opengraph-image',
  ogTitle,
  ogDescription,
  noindex = false,
  keywords = [],
  publishedTime,
  modifiedTime,
  authors,
  type = 'website',
  locale = DEFAULT_LOCALE,
  availableLocales = APP_LOCALES,
}: SeoOptions): Metadata {
  // The suffix is worth having until it pushes the title past what a result
  // page shows. Open Graph and Twitter keep the branded form either way —
  // there the sixty-character budget does not apply.
  const brandedTitle = title ? `${title} — ${BRAND.domain}` : `${BRAND.domain}`;
  const fullTitle = title && brandedTitle.length > TITLE_BUDGET ? title : brandedTitle;
  const normalizedPath = path || '';
  const localizedPath = localizePathname(normalizedPath || '/', locale);
  const url = absoluteUrl(localizedPath);
  const resolvedOgImage = ogImage.startsWith('http://') || ogImage.startsWith('https://')
    ? ogImage
    : absoluteUrl(ogImage);
  const preview = isPreviewDeployment();
  const preventIndexing = noindex || preview;
  const localeRoutesEnabled = rolloutFeatureEnabled('localeRoutes');
  const publishedLanguages = new Set<string>([
    ...availableLocales.map((candidate) => HREFLANG_BY_LOCALE[candidate]),
    'x-default',
  ]);
  const languageAlternates = Object.fromEntries(
    Object.entries(localeAlternates(normalizedPath || '/'))
      .filter(([language]) =>
        localeRoutesEnabled
          ? publishedLanguages.has(language)
          : language === 'ru-KZ' || language === 'x-default',
      )
      .map(([language, pathname]) => [language, absoluteUrl(pathname)]),
  );
  const keywordList = [...(locale === 'ru' ? BASE_KEYWORDS : []), ...keywords];
  return {
    metadataBase: new URL(absoluteUrl('/')),
    title: fullTitle,
    description,
    // An empty string is worse than no tag: it was emitted on every kk, en and
    // zh page, which have no Russian base list to fall back on.
    ...(keywordList.length > 0 ? { keywords: keywordList.join(', ') } : {}),
    authors: authors?.map((name) => ({ name })) ?? [{ name: BRAND.domain }],
    creator: BRAND.domain,
    publisher: BRAND.domain,
    applicationName: BRAND.domain,
    category: 'education',
    robots: preventIndexing
      ? // A page kept out of the index should still pass a crawler along to the
        // pages it points at — a superseded legal revision links to the one in
        // force. A preview deployment is the exception: nothing there should be
        // crawled or followed at all.
        { index: false, follow: !preview }
      : {
          index: true,
          follow: true,
          googleBot: {
            index: true,
            follow: true,
            'max-snippet': -1,
            'max-image-preview': 'large',
            'max-video-preview': -1,
          },
        },
    alternates: { canonical: url, languages: languageAlternates },
    openGraph: {
      type,
      url,
      siteName: BRAND.domain,
      title: ogTitle ?? fullTitle,
      description: ogDescription ?? description,
      locale: openGraphLocale(locale),
      alternateLocale: localeRoutesEnabled
        ? APP_LOCALES.filter((candidate) => candidate !== locale).map((candidate) =>
            openGraphLocale(candidate),
          )
        : [],
      // Only the generated card has a size this code can vouch for. Article
      // covers are 1200×800 and declaring 1200×630 for them cropped the preview;
      // with no declaration the crawler measures the file itself.
      images: [
        {
          url: resolvedOgImage,
          ...(ogImage === '/opengraph-image' ? { width: 1200, height: 630 } : {}),
          alt: title ?? BRAND.domain,
        },
      ],
      ...(publishedTime ? { publishedTime } : {}),
      ...(modifiedTime ? { modifiedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle ?? brandedTitle,
      description: ogDescription ?? description,
      images: [resolvedOgImage],
    },
    other: {
      google: 'notranslate',
      'geo.region': 'KZ-ALA',
      'geo.placename': LOCALIZED_CITY[locale],
      'geo.position': '43.2389;76.8897',
      ICBM: '43.2389, 76.8897',
    },
  };
}

export function organizationJsonLd(
  contacts: SiteContactSettings,
  locale: AppLocale = DEFAULT_LOCALE,
  localized?: { description?: string; city?: string },
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'EducationalOrganization',
    // The identity is the company, not the locale of the page describing it.
    '@id': organizationId(),
    name: BRAND.domain,
    legalName: BRAND.domain,
    url: absoluteUrl('/'),
    logo: absoluteUrl('/icons/icon-512x512.png'),
    description: localized?.description,
    address: {
      '@type': 'PostalAddress',
      // `localized.city` is the footer line — «Казахстан, г. Алматы» — written
      // for a reader, not for a field that means the settlement alone.
      addressLocality: LOCALIZED_CITY[locale],
      addressCountry: 'KZ',
    },
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: contacts.phoneDisplay,
      contactType: 'customer service',
      areaServed: 'KZ',
      availableLanguage: servedLocales().map((candidate) => SCHEMA_LANGUAGE_NAME[candidate]),
    },
    areaServed: { '@type': 'Country', name: 'Kazakhstan' },
  };
}

const SCHEMA_LANGUAGE_NAME = {
  ru: 'Russian',
  kk: 'Kazakh',
  en: 'English',
  zh: 'Chinese',
} as const satisfies Record<AppLocale, string>;

/**
 * The locales actually reachable right now. Prefixed routes are behind a
 * rollout flag, and until it is on the site answers Russian only — announcing
 * four languages in the structured data invited crawls of URLs that 404.
 */
function servedLocales(): readonly AppLocale[] {
  return rolloutFeatureEnabled('localeRoutes') ? APP_LOCALES : [DEFAULT_LOCALE];
}

export function websiteJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': absoluteUrl('/#website'),
    name: BRAND.domain,
    url: absoluteUrl('/'),
    publisher: { '@id': organizationId() },
    // One entity, one identity — so the locale of the page describing it is not
    // part of it. Previously each locale emitted a WebSite of its own with its
    // own url and its own inLanguage, which described four different sites.
    inLanguage: servedLocales().map((candidate) => htmlLanguage(candidate)),
  };
}

export function courseJsonLd(input: {
  name: string;
  description: string;
  url: string;
  locale?: AppLocale;
  credentialName?: string;
  durationMinutes?: number;
  image?: string;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: input.name,
    description: input.description,
    // A reference rather than a copy: the catalogue called the provider
    // «SafetyHub» and the course page called it «SafetyHub.kz», for the same
    // course.
    provider: { '@id': organizationId() },
    url: input.url,
    inLanguage: htmlLanguage(input.locale ?? DEFAULT_LOCALE),
    educationalCredentialAwarded: input.credentialName,
    ...(input.image
      ? { image: [input.image.startsWith('http') ? input.image : absoluteUrl(input.image)] }
      : {}),
    // The delivery mode belongs to the instance, and the instance is held
    // online — a Place named after the office described a course nobody
    // attends there. `offers` is deliberately absent: nothing on the page
    // states a price, and declaring one in the markup only would be a claim
    // the site does not make to a reader.
    hasCourseInstance: {
      '@type': 'CourseInstance',
      courseMode: 'Online',
      location: { '@type': 'VirtualLocation', url: input.url },
      ...(input.durationMinutes ? { courseWorkload: `PT${input.durationMinutes}M` } : {}),
    },
  };
}

export function breadcrumbsJsonLd(items: readonly { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function faqJsonLd(items: readonly { question: string; answer: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.answer },
    })),
  };
}

export function articleJsonLd(input: {
  headline: string;
  description: string;
  image: string;
  datePublished: string;
  dateModified?: string;
  author: string;
  url: string;
  locale?: AppLocale;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: input.headline,
    description: input.description,
    image: [input.image.startsWith('http') ? input.image : absoluteUrl(input.image)],
    datePublished: input.datePublished,
    dateModified: input.dateModified ?? input.datePublished,
    // The name is the editorial team, not a person: no article in the
    // repository or in the database carries an author field.
    author: { '@type': 'Organization', name: input.author, '@id': organizationId() },
    publisher: { '@id': organizationId() },
    mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
    isPartOf: { '@id': absoluteUrl('/#website') },
    inLanguage: htmlLanguage(input.locale ?? DEFAULT_LOCALE),
  };
}

