import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { getTopics } from '@/lib/content/topics';
import { getArticles } from '@/lib/content/articles';
import { APP_LOCALES, localeAlternates, localizePathname } from '@/i18n/config';
import { DEFAULT_LOCALE, type AppLocale } from '@/i18n/config';
import { PRIVACY_POLICY, TERMS_POLICY } from '@/lib/legal';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

const HREFLANG_BY_LOCALE = {
  ru: 'ru-KZ',
  kk: 'kk-KZ',
  en: 'en',
  zh: 'zh-Hans',
} as const satisfies Record<AppLocale, string>;

// Update this only when the static public shell or legal pages actually change.
// Dynamic courses and articles use their persisted revision timestamps below.
const STATIC_LAST_MODIFIED = new Date('2026-08-19T00:00:00.000Z');

function contentDate(value: string | null | undefined) {
  if (!value) return STATIC_LAST_MODIFIED;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? STATIC_LAST_MODIFIED : date;
}

/**
 * One URL per locale the document actually exists in.
 *
 * The rollout list used to be expanded unconditionally, so a course published
 * only in Russian still contributed /kk, /en and /zh entries — URLs that answer
 * 404 — and each of them advertised the other three as hreflang alternates.
 */
function localizedEntries(input: {
  path: string;
  lastModified: Date;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  priority: number;
  availableLocales?: readonly AppLocale[];
}): MetadataRoute.Sitemap {
  const rollout = rolloutFeatureEnabled('localeRoutes') ? APP_LOCALES : [DEFAULT_LOCALE];
  const available = input.availableLocales;
  const locales = rollout.filter((locale) => !available || available.includes(locale));
  const published = new Set<string>([
    ...locales.map((locale) => HREFLANG_BY_LOCALE[locale]),
    'x-default',
  ]);
  const languages = Object.fromEntries(
    Object.entries(localeAlternates(input.path))
      .filter(([language]) => published.has(language))
      .map(([language, pathname]) => [language, absoluteUrl(pathname)]),
  );

  return locales.map((locale) => ({
    url: absoluteUrl(localizePathname(input.path, locale)),
    lastModified: input.lastModified,
    changeFrequency: input.changeFrequency,
    priority: input.priority,
    alternates: { languages },
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPaths = ['', '/topics', '/faq', '/contacts', '/privacy', '/terms', '/blog'];
  // A document marked `indexable: false` carries a noindex meta tag; listing it
  // here at the same time tells a crawler two opposite things about the same
  // URL, and the sitemap is the one it fetches first.
  const rollout = rolloutFeatureEnabled('localeRoutes') ? APP_LOCALES : [DEFAULT_LOCALE];

  // A slug is listed for a locale only if that localization exists. The Russian
  // list used to be expanded across all four, so every course published in one
  // language contributed three URLs that answer 404.
  const localesBySlug = async (
    lists: readonly (readonly { slug: string }[])[],
    slug: string,
  ): Promise<readonly AppLocale[]> =>
    rollout.filter((_, index) => (lists[index] ?? []).some((item) => item.slug === slug));

  const topicLists = await Promise.all(rollout.map((locale) => getTopics(locale)));
  const topics = (await getTopics()).filter((topic) => topic.seo.indexable);
  const topicEntries = await Promise.all(
    topics.map(async (topic) => ({
      path: `/topics/${topic.slug}`,
      lastModified: contentDate(topic.updatedAt),
      availableLocales: await localesBySlug(topicLists, topic.slug),
    })),
  );

  const articleLists = await Promise.all(rollout.map((locale) => getArticles(locale)));
  const articles = (await getArticles()).filter((article) => article.seo?.indexable !== false);
  const articleEntries = await Promise.all(
    articles.map(async (p) => ({
      path: `/blog/${p.slug}`,
      lastModified: contentDate(p.updatedAt ?? p.createdAt),
      availableLocales: await localesBySlug(articleLists, p.slug),
    })),
  );

  const entries: MetadataRoute.Sitemap = [];

  // lastmod has to track a real change or the signal stops being believed for
  // the whole domain. It was a constant from August, stale the moment any
  // course or article was published.
  const newest = (dates: readonly Date[]) =>
    dates.reduce((latest, value) => (value > latest ? value : latest), STATIC_LAST_MODIFIED);
  const newestTopic = newest(topicEntries.map((topic) => topic.lastModified));
  const newestArticle = newest(articleEntries.map((article) => article.lastModified));
  const staticLastModified = (path: string) => {
    if (path === '/privacy') return contentDate(`${PRIVACY_POLICY.effectiveDate}T00:00:00+05:00`);
    if (path === '/terms') return contentDate(`${TERMS_POLICY.effectiveDate}T00:00:00+05:00`);
    if (path === '/blog') return newestArticle;
    if (path === '/topics') return newestTopic;
    if (path === '') return newest([newestTopic, newestArticle]);
    return STATIC_LAST_MODIFIED;
  };

  for (const path of staticPaths) {
    entries.push(
      ...localizedEntries({
        path: path || '/',
        lastModified: staticLastModified(path),
        changeFrequency: path === '' ? 'daily' : path === '/blog' ? 'daily' : 'weekly',
        priority: path === '' ? 1 : path === '/blog' ? 0.9 : 0.7,
      }),
    );
  }

  for (const topic of topicEntries) {
    entries.push(
      ...localizedEntries({
        path: topic.path,
        lastModified: topic.lastModified,
        changeFrequency: 'weekly',
        priority: 0.85,
        availableLocales: topic.availableLocales,
      }),
    );
  }

  for (const article of articleEntries) {
    entries.push(
      ...localizedEntries({
        path: article.path,
        lastModified: article.lastModified,
        changeFrequency: 'monthly',
        priority: 0.75,
        availableLocales: article.availableLocales,
      }),
    );
  }

  return entries;
}
