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
import { getLocale, getTranslations } from 'next-intl/server';
import { localizePathname } from '@/i18n/config';

export async function CourseGrid() {
  const [locale, t, courseT, footerT] = await Promise.all([
    getLocale(),
    getTranslations('Home.courses'),
    getTranslations('Course'),
    getTranslations('Shell.footer'),
  ]);
  const topics = await getTopics(locale);

  return (
    <>
      {topics.map((topic) => (
        <JsonLd
          key={`schema-${topic.slug}`}
          data={courseJsonLd({
            name: topic.title,
            description: topic.description,
            provider: 'SafetyHub',
            url: absoluteUrl(localizePathname(ROUTES.topic(topic.slug), locale)),
            locale,
            credentialName: courseT('credentialAwarded'),
            locationName: footerT('city'),
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
            eyebrow={t('eyebrow')}
            title={t('title')}
            description={t('description')}
            action={
              <Link
                href={localizePathname(ROUTES.topics, locale)}
                className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)]/70 px-4 text-sm font-semibold text-[var(--color-text)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/45 hover:bg-[var(--color-primary-soft)] hover:text-[var(--color-on-primary-soft)]"
              >
                {t('all')}
                <ArrowUpRight size={17} weight="bold" aria-hidden="true" />
              </Link>
            }
          />

          {topics.length > 0 ? (
            <MarketingSlider label={t('slider')} itemLabel={t('item')} className="mt-7 sm:mt-10">
              {topics.map((topic) => (
                <CourseCard
                  key={topic.slug}
                  slug={topic.slug}
                  title={topic.title}
                  icon={topic.icon}
                  coverImage={getCourseCoverImage(topic.slug, topic.seo.ogImage)}
                  durationMinutes={topic.durationMinutes}
                  questionCount={topic.questionCount}
                  pageCount={topic.presentation?.pageCount}
                  // The LCP hero is the only public image intentionally preloaded.
                  // Course covers are below the fold and should not compete with it.
                  priority={false}
                />
              ))}
            </MarketingSlider>
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
