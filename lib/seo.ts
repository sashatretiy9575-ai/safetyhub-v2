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
};

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
}: SeoOptions): Metadata {
  const fullTitle = title ? `${title} — ${BRAND.domain}` : `${BRAND.domain}`;
  const normalizedPath = path || '';
  const localizedPath = localizePathname(normalizedPath || '/', locale);
  const url = absoluteUrl(localizedPath);
  const resolvedOgImage = ogImage.startsWith('http://') || ogImage.startsWith('https://')
    ? ogImage
    : absoluteUrl(ogImage);
  const preventIndexing = noindex || isPreviewDeployment();
  const localeRoutesEnabled = rolloutFeatureEnabled('localeRoutes');
  const languageAlternates = Object.fromEntries(
    Object.entries(localeAlternates(normalizedPath || '/'))
      .filter(
        ([language]) => localeRoutesEnabled || language === 'ru-KZ' || language === 'x-default',
      )
      .map(([language, pathname]) => [language, absoluteUrl(pathname)]),
  );
  return {
    metadataBase: new URL(absoluteUrl('/')),
    title: fullTitle,
    description,
    keywords: [...(locale === 'ru' ? BASE_KEYWORDS : []), ...keywords].join(', '),
    authors: authors?.map((name) => ({ name })) ?? [{ name: BRAND.domain }],
    creator: BRAND.domain,
    publisher: BRAND.domain,
    applicationName: BRAND.domain,
    category: 'education',
    robots: preventIndexing
      ? { index: false, follow: false }
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
      images: [{ url: resolvedOgImage, width: 1200, height: 630, alt: title ?? BRAND.domain }],
      ...(publishedTime ? { publishedTime } : {}),
      ...(modifiedTime ? { modifiedTime } : {}),
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle ?? fullTitle,
      description: ogDescription ?? description,
      images: [resolvedOgImage],
    },
    other: {
      google: 'notranslate',
      'geo.region': 'KZ-ALA',
      'geo.placename': BRAND.city,
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
    name: BRAND.domain,
    legalName: BRAND.domain,
    url: absoluteUrl(localizePathname('/', locale)),
    logo: absoluteUrl('/icons/icon-512x512.png'),
    description: localized?.description,
    address: {
      '@type': 'PostalAddress',
      addressLocality: localized?.city ?? BRAND.city,
      addressCountry: 'KZ',
    },
    contactPoint: {
      '@type': 'ContactPoint',
      telephone: contacts.phoneDisplay,
      contactType: 'customer service',
      areaServed: 'KZ',
      availableLanguage: ['Russian', 'Kazakh', 'English', 'Chinese'],
    },
    areaServed: { '@type': 'Country', name: 'Kazakhstan' },
  };
}

export function websiteJsonLd(locale: AppLocale = DEFAULT_LOCALE) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: BRAND.domain,
    url: absoluteUrl(localizePathname('/', locale)),
    inLanguage: htmlLanguage(locale),
    availableLanguage: APP_LOCALES.map((candidate) => htmlLanguage(candidate)),
  };
}

export function courseJsonLd(input: {
  name: string;
  description: string;
  url: string;
  provider?: string;
  locale?: AppLocale;
  credentialName?: string;
  locationName?: string;
  durationMinutes?: number;
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: input.name,
    description: input.description,
    provider: {
      '@type': 'EducationalOrganization',
      name: input.provider ?? BRAND.domain,
      sameAs: absoluteUrl(localizePathname('/', input.locale ?? DEFAULT_LOCALE)),
    },
    url: input.url,
    inLanguage: htmlLanguage(input.locale ?? DEFAULT_LOCALE),
    educationalCredentialAwarded: input.credentialName,
    courseMode: 'online',
    ...(input.durationMinutes
      ? {
          hasCourseInstance: {
            '@type': 'CourseInstance',
            courseMode: 'online',
            courseWorkload: `PT${input.durationMinutes}M`,
          },
        }
      : {}),
    ...(input.locationName
      ? { locationCreated: { '@type': 'Place', name: input.locationName } }
      : {}),
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
    author: { '@type': 'Person', name: input.author },
    publisher: {
      '@type': 'Organization',
      name: BRAND.domain,
      logo: { '@type': 'ImageObject', url: absoluteUrl('/icons/icon-512x512.png') },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': input.url },
    inLanguage: htmlLanguage(input.locale ?? DEFAULT_LOCALE),
  };
}

export function localBusinessJsonLd(
  contacts: SiteContactSettings,
  locale: AppLocale = DEFAULT_LOCALE,
  city: string = BRAND.city,
) {
  return {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    '@id': absoluteUrl(`${localizePathname('/', locale)}#org`),
    name: BRAND.domain,
    image: absoluteUrl('/opengraph-image'),
    url: absoluteUrl(localizePathname('/', locale)),
    telephone: contacts.phoneDisplay,
    address: {
      '@type': 'PostalAddress',
      addressLocality: city,
      addressRegion: city,
      addressCountry: 'KZ',
    },
    geo: { '@type': 'GeoCoordinates', latitude: 43.2389, longitude: 76.8897 },
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        opens: '09:00',
        closes: '18:00',
      },
    ],
    areaServed: ['Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Aktobe', 'Kazakhstan'],
  };
}
