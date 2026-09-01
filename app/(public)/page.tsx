import { Suspense } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Hero } from '@/components/marketing/hero';
import { PartnersStrip } from '@/components/marketing/partners-strip';
import { CourseGrid } from '@/components/marketing/course-grid';
import { ProcessTimeline } from '@/components/marketing/process-timeline';
import { Testimonials } from '@/components/marketing/testimonials';
import { Resources } from '@/components/marketing/resources';
import { FaqAccordion, getFaqData } from '@/components/marketing/faq-accordion';
import { ContactCta } from '@/components/marketing/contact-cta';
import { JsonLd } from '@/components/shared/json-ld';
import { buildMetadata, faqJsonLd } from '@/lib/seo';

function HomeSectionFallback({ label }: { label: string }) {
  return (
    <section
      aria-label={label}
      className="mx-auto w-full max-w-[1280px] px-4 py-10 sm:py-14 md:px-6 lg:py-16 xl:px-8"
    >
      <div className="h-6 w-56 animate-pulse rounded bg-[var(--color-surface-muted)] sm:h-8" />
      <div className="mt-7 flex gap-3 overflow-hidden pr-[14%] min-[1200px]:grid min-[1200px]:grid-cols-3 min-[1200px]:gap-5 min-[1200px]:pr-0 sm:mt-10 sm:gap-4 sm:pr-[12%]">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="h-[25rem] min-w-[min(82vw,19.5rem)] animate-pulse rounded-[24px] bg-[var(--color-surface-soft)] min-[1200px]:min-w-0 sm:min-w-[calc((100%_-_1rem)/2.15)]"
            aria-hidden="true"
          />
        ))}
      </div>
    </section>
  );
}

export async function generateMetadata() {
  const t = await getTranslations('Home');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    path: '/',
    locale: await getLocale(),
  });
}

export default async function HomePage() {
  const [t, faqData] = await Promise.all([getTranslations('Home'), getFaqData()]);
  return (
    <>
      <JsonLd data={faqJsonLd(faqData)} />
      <Hero />
      <Suspense fallback={<HomeSectionFallback label={t('loadingCourses')} />}>
        <CourseGrid />
      </Suspense>
      <PartnersStrip />
      <ProcessTimeline />
      <Suspense fallback={<HomeSectionFallback label={t('loadingResources')} />}>
        <Resources />
      </Suspense>
      <Testimonials />
      <FaqAccordion />
      <ContactCta />
    </>
  );
}
