import { CourseCard } from '@/components/marketing/course-card';
import { Container } from '@/components/ui/container';
import { PageHeader } from '@/components/ui/page-header';
import { getTopics } from '@/lib/content/topics';
import { getCourseCoverImage } from '@/lib/course-cover-images';
import { buildMetadata } from '@/lib/seo';

export const metadata = buildMetadata({
  title: 'Онлайн-курсы по безопасности для сотрудников',
  description:
    'Пожарная и промышленная безопасность, охрана труда — онлайн по Казахстану с поддержкой команды в Алматы.',
  path: '/topics',
  keywords: ['курсы по безопасности', 'охрана труда', 'промышленная безопасность онлайн'],
});

export default async function TopicsPage() {
  const topics = await getTopics();

  return (
    <>
      <PageHeader
        title="Курсы по безопасности"
        description="Охрана труда, пожарная и промышленная безопасность — онлайн по всему Казахстану."
        eyebrow="Алматы · онлайн по Казахстану"
        variant="compact"
      />

      <section aria-labelledby="topics-catalog-heading" className="py-7 sm:py-10 lg:py-12">
        <Container size="wide">
          <h2 id="topics-catalog-heading" className="sr-only">
            Доступные курсы
          </h2>
          {topics.length === 0 ? (
            <div className="rounded-[24px] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 p-6 text-left backdrop-blur-xl">
              <p className="font-bold">Курсы готовятся</p>
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                Каталог скоро появится здесь.
              </p>
            </div>
          ) : (
            <div
              className="grid items-stretch gap-4 min-[1200px]:grid-cols-3 sm:grid-cols-2 lg:gap-5"
              aria-label="Каталог курсов"
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
