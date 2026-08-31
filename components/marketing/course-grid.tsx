import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { CourseCard } from '@/components/marketing/course-card';
import { SectionHeading } from '@/components/marketing/_shared/section-heading';
import { Container } from '@/components/ui/container';
import { MarketingSlider } from '@/components/ui/marketing-slider';
import { JsonLd } from '@/components/shared/json-ld';
import { ROUTES } from '@/lib/constants';
import { getTopics } from '@/lib/content/topics';
import { getCourseCoverImage } from '@/lib/course-cover-images';
import { courseJsonLd } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';

export async function CourseGrid() {
  const topics = await getTopics();

  return (
    <>
      {topics.map((topic) => (
        <JsonLd
          key={`schema-${topic.slug}`}
          data={courseJsonLd({
            name: topic.title,
            description: topic.description,
            provider: 'SafetyHub',
            url: absoluteUrl(ROUTES.topic(topic.slug)),
          })}
        />
      ))}

      <section
        id="courses"
        aria-labelledby="courses-heading"
        className="scroll-mt-24 py-10 sm:py-14 lg:py-16"
      >
        <Container size="wide">
          <SectionHeading
            id="courses-heading"
            eyebrow="Программы обучения"
            title="Курсы по безопасности для специалистов и команд"
            description="Выберите направление и проходите обучение в удобном темпе."
            action={
              <Link
                href={ROUTES.topics}
                prefetch={false}
                className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 px-4 text-sm font-semibold text-[var(--color-text)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-on-primary-soft)]"
              >
                Все курсы
                <ArrowUpRight size={17} weight="bold" aria-hidden="true" />
              </Link>
            }
          />

          {topics.length > 0 ? (
            <MarketingSlider label="Программы обучения" itemLabel="Курс" className="mt-7 sm:mt-10">
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
                  priority={index < 3}
                />
              ))}
            </MarketingSlider>
          ) : (
            <p className="mt-6 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 p-6 text-sm text-[var(--color-text-muted)] backdrop-blur-xl">
              Опубликованные курсы скоро появятся.
            </p>
          )}
        </Container>
      </section>
    </>
  );
}
