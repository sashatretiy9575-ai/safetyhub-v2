import { notFound, permanentRedirect } from 'next/navigation';
import { getTopicBySlug, getTopicRedirectBySlug, getTopicSlugs } from '@/lib/content/topics';
import { CourseMaterialActions } from '@/components/topics/course-material-actions';
import { JsonLd } from '@/components/shared/json-ld';
import { breadcrumbsJsonLd, buildMetadata, courseJsonLd } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { TopicSourcesCard } from '@/components/topics/topic-sources-card';

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const topic = await getTopicBySlug(slug);
  if (!topic) return {};

  return buildMetadata({
    title: topic.seo.title,
    description: topic.seo.description,
    ogTitle: topic.seo.ogTitle,
    ogDescription: topic.seo.ogDescription,
    ogImage: topic.seo.ogImage || '/opengraph-image',
    noindex: !topic.seo.indexable,
    path: `/topics/${slug}`,
    type: 'article',
    keywords: [topic.title, 'тестирование по безопасности'],
  });
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const topic = await getTopicBySlug(slug);
  if (!topic) {
    const destination = await getTopicRedirectBySlug(slug);
    if (destination) permanentRedirect(`/topics/${destination}`);
    if (slug === 'industrial-safety') permanentRedirect('/topics');
    if (slug === 'fire-safety') permanentRedirect('/topics/pozharnaya-bezopasnost');
    if (slug === 'occupational-health') permanentRedirect('/topics/biot');
    notFound();
  }

  return (
    <>
      <JsonLd
        data={[
          courseJsonLd({
            name: topic.title,
            description: topic.description,
            url: absoluteUrl(`/topics/${topic.slug}`),
          }),
          breadcrumbsJsonLd([
            { name: 'Главная', url: absoluteUrl('/') },
            { name: 'Курсы', url: absoluteUrl('/topics') },
            { name: topic.title, url: absoluteUrl(`/topics/${topic.slug}`) },
          ]),
        ]}
      />
      <CourseMaterialActions course={topic} />
      <TopicSourcesCard topic={topic} />
    </>
  );
}
