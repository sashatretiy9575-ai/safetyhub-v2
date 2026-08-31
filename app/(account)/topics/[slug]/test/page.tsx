import { notFound } from 'next/navigation';
import { getTopicBySlug, getTopicSlugs } from '@/lib/content/topics';
import { QuizClient } from '@/components/quiz/quiz-client';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Тестирование',
  description: 'Проверка знаний на платформе SafetyHub.',
  noindex: true,
});

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export default async function TestPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const topic = await getTopicBySlug(slug);
  if (!topic) notFound();

  return <QuizClient slug={topic.slug} title={topic.title} />;
}
