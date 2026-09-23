import { CourseCard } from '@/components/marketing/course-card';
import { SectionHeading } from '@/components/marketing/shared/section-heading';
import { Container } from '@/components/ui/container';
import { JsonLd } from '@/components/shared/json-ld';
import { ROUTES } from '@/lib/constants';
import { getTopics } from '@/server/content/topics';
import { getCourseCoverImage } from '@/lib/content/course-cover-images';
import { courseJsonLd } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { getLocale, getTranslations } from 'next-intl/server';
import { localizePathname } from '@/i18n/config';

export async function CourseGrid() {
  const [locale, t, courseT] = await Promise.all([
    getLocale(),
    getTranslations('Home.courses'),
    getTranslations('Course'),
  ]);
  const topics = await getTopics(locale);

  return (
    <>
      {/* One list, not five loose Course nodes: the catalogue is an ordered
          set, and a search engine reading five roots on one page cannot tell
          which of them the page is about. */}
      <JsonLd
        data={{
          '@context': 'https://schema.org',
          '@type': 'ItemList',
          itemListElement: topics.map((topic, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            item: courseJsonLd({
              name: topic.title,
              description: topic.description,
              url: absoluteUrl(localizePathname(ROUTES.topic(topic.slug), locale)),
              locale,
              credentialName: courseT('credentialAwarded'),
              durationMinutes: topic.durationMinutes,
              image: getCourseCoverImage(topic.slug, locale, topic.seo.ogImage),
            }),
          })),
        }}
      />

      <section
        id="courses"
        aria-labelledby="courses-heading"
        className="scroll-mt-24 py-10 sm:py-14 lg:py-16"
      >
        <Container size="wide">
          {/* The grid below already shows every published course, so the
              "all courses" link and the filler sentence under the heading
              only repeated it. Two a row on a phone, not a slider: there are
              many courses and more to come, and a slider hides all but one. */}
          <SectionHeading id="courses-heading" eyebrow={t('eyebrow')} title={t('title')} />

          {topics.length > 0 ? (
            <div
              aria-label={t('slider')}
              className="mt-7 grid grid-cols-1 items-stretch gap-3 min-[360px]:grid-cols-2 sm:mt-10 sm:gap-4 md:grid-cols-3 lg:gap-5 xl:grid-cols-4"
            >
              {topics.map((topic) => (
                <CourseCard
                  key={topic.slug}
                  slug={topic.slug}
                  title={topic.title}
                  description={topic.description}
                  icon={topic.icon}
                  coverImage={getCourseCoverImage(topic.slug, locale, topic.seo.ogImage)}
                  durationMinutes={topic.durationMinutes}
                  questionCount={topic.questionCount}
                  pageCount={topic.presentation?.pageCount}
                  // The LCP hero is the only public image intentionally preloaded.
                  // Course covers are below the fold and should not compete with it.
                  priority={false}
                />
              ))}
            </div>
          ) : (
            <p className="mt-6 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 p-6 text-sm text-[var(--color-text-muted)] backdrop-blur-xl">
              {t('empty')}
            </p>
          )}
        </Container>
      </section>
    </>
  );
}
