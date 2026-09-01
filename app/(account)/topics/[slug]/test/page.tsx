import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getTopicBySlug, getTopicSlugs } from '@/lib/content/topics';
import { QuizClient } from '@/components/quiz/quiz-client';
import { buildMetadata } from '@/lib/seo';
import type { AppLocale } from '@/i18n/config';

export async function generateMetadata() {
  const [locale, t] = await Promise.all([
    getLocale() as Promise<AppLocale>,
    getTranslations('Quiz'),
  ]);
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    noindex: true,
    locale,
  });
}

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export default async function TestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = (await getLocale()) as AppLocale;

  const topic = await getTopicBySlug(slug, locale);
  if (!topic) notFound();

  return <QuizClient slug={topic.slug} title={topic.title} />;
}
