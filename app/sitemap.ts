import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/utils';
import { getTopics } from '@/lib/content/topics';
import { getArticles } from '@/lib/content/articles';

// Update this only when the static public shell or legal pages actually change.
// Dynamic courses and articles use their persisted revision timestamps below.
const STATIC_LAST_MODIFIED = new Date('2026-08-19T00:00:00.000Z');

function contentDate(value: string | null | undefined) {
  if (!value) return STATIC_LAST_MODIFIED;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? STATIC_LAST_MODIFIED : date;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPaths = [
    '',
    '/topics',
    '/faq',
    '/contacts',
    '/privacy',
    '/terms',
    '/blog',
  ];
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
    entries.push({
      url: absoluteUrl(path || '/'),
      lastModified: STATIC_LAST_MODIFIED,
      changeFrequency: path === '' ? 'daily' : path === '/blog' ? 'daily' : 'weekly',
      priority: path === '' ? 1 : path === '/blog' ? 0.9 : 0.7,
    });
  }

  for (const topic of topicEntries) {
    entries.push({
      url: absoluteUrl(topic.path),
      lastModified: topic.lastModified,
      changeFrequency: 'weekly',
      priority: 0.85,
    });
  }

  for (const article of articleEntries) {
    entries.push({
      url: absoluteUrl(article.path),
      lastModified: article.lastModified,
      changeFrequency: 'monthly',
      priority: 0.75,
    });
  }

  return entries;
}
