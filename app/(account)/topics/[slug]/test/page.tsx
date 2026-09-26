import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getTopicBySlug, getTopicSlugs } from '@/server/content/topics';
import { QuizClient } from '@/components/quiz/quiz-client';
import { buildMetadata } from '@/lib/seo';
import type { AppLocale } from '@/i18n/config';
import { getPrivateRequestLocale } from '@/i18n/private-request-locale';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await getPrivateRequestLocale();
  const [t, topic] = await Promise.all([
    getTranslations({ locale, namespace: 'Quiz' }),
    getTopicBySlug(slug, locale),
  ]);
  return buildMetadata({
    // Every test tab used to carry the same title; with several courses open
    // the tabs could not be told apart.
    title: topic ? `${t('metadataTitle')}: ${topic.title}` : t('metadataTitle'),
    description: t('metadataDescription'),
    // Without a path this canonicalised to «/» and inherited the home page's
    // hreflang cluster, on a screen that is noindex to begin with.
    path: `/topics/${encodeURIComponent(slug)}/test`,
    noindex: true,
    locale,
  });
}

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export default async function TestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = (await getPrivateRequestLocale()) as AppLocale;

  const topic = await getTopicBySlug(slug, locale);
  if (!topic) notFound();

  return <QuizClient slug={topic.slug} title={topic.title} />;
}
