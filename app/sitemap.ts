import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { getTopics } from '@/lib/content/topics';
import { getArticles } from '@/lib/content/articles';
import { APP_LOCALES, localeAlternates, localizePathname } from '@/i18n/config';
import { DEFAULT_LOCALE } from '@/i18n/config';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

// Update this only when the static public shell or legal pages actually change.
// Dynamic courses and articles use their persisted revision timestamps below.
const STATIC_LAST_MODIFIED = new Date('2026-08-19T00:00:00.000Z');

function contentDate(value: string | null | undefined) {
  if (!value) return STATIC_LAST_MODIFIED;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? STATIC_LAST_MODIFIED : date;
}

function localizedEntries(input: {
  path: string;
  lastModified: Date;
  changeFrequency: 'daily' | 'weekly' | 'monthly';
  priority: number;
}): MetadataRoute.Sitemap {
  const locales = rolloutFeatureEnabled('localeRoutes') ? APP_LOCALES : [DEFAULT_LOCALE];
  const languages = Object.fromEntries(
    Object.entries(localeAlternates(input.path))
      .filter(
        ([language]) => locales.length > 1 || language === 'ru-KZ' || language === 'x-default',
      )
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
  const topics = await getTopics();
  const topicEntries = topics.map((topic) => ({
    path: `/topics/${topic.slug}`,
    lastModified: contentDate(topic.updatedAt),
  }));

  const articles = await getArticles();
  const articleEntries = articles.map((p) => ({
    path: `/blog/${p.slug}`,
    lastModified: contentDate(p.updatedAt ?? p.createdAt),
  }));

  const entries: MetadataRoute.Sitemap = [];

  for (const path of staticPaths) {
    entries.push(
      ...localizedEntries({
        path: path || '/',
        lastModified: STATIC_LAST_MODIFIED,
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
      }),
    );
  }

  return entries;
}
