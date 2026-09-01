import { CourseCard } from '@/components/marketing/course-card';
import { getLocale, getTranslations } from 'next-intl/server';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { getTopics } from '@/lib/content/topics';
import { getCourseCoverImage } from '@/lib/course-cover-images';
import { buildMetadata } from '@/lib/seo';

export async function generateMetadata() {
  const t = await getTranslations('Topics');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    path: '/topics',
    keywords: [t('metadataKeyword1'), t('metadataKeyword2'), t('metadataKeyword3')],
    locale: await getLocale(),
  });
}

export default async function TopicsPage() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('Topics')]);
  const topics = await getTopics(locale);

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        eyebrow={t('eyebrow')}
        variant="compact"
      />

      <section aria-labelledby="topics-catalog-heading" className="py-7 sm:py-10 lg:py-12">
        <Container size="wide">
          <h2 id="topics-catalog-heading" className="sr-only">
            {t('available')}
          </h2>
          {topics.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 p-6 text-left backdrop-blur-xl">
              <p className="font-bold">{t('emptyTitle')}</p>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                {t('emptyDescription')}
              </p>
            </div>
          ) : (
            <div
              className="grid items-stretch gap-4 min-[1200px]:grid-cols-3 sm:grid-cols-2 lg:gap-5"
              aria-label={t('catalogAria')}
            >
              {topics.map((topic, index) => (
                <CourseCard
                  key={topic.slug}
                  slug={topic.slug}
                  title={topic.title}
                  icon={topic.icon}
                  coverImage={getCourseCoverImage(topic.slug)}
                  durationMinutes={topic.durationMinutes}
                  questionCount={topic.questionCount}
                  pageCount={topic.presentation?.pageCount}
                  priority={index < 2}
                />
              ))}
            </div>
          )}
        </Container>
      </section>
    </>
  );
}
