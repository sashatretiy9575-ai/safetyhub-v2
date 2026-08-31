import { Suspense } from 'react';
import { Hero } from '@/components/marketing/hero';
import { PartnersStrip } from '@/components/marketing/partners-strip';
import { CourseGrid } from '@/components/marketing/course-grid';
import { ProcessTimeline } from '@/components/marketing/process-timeline';
import { Testimonials } from '@/components/marketing/testimonials';
import { Resources } from '@/components/marketing/resources';
import { FAQ_DATA, FaqAccordion } from '@/components/marketing/faq-accordion';
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

export const metadata = buildMetadata({
  title: 'Обучение по охране труда',
  description:
    'Онлайн-обучение по промышленной безопасности, охране труда и пожарной безопасности.',
  path: '/',
});

export default function HomePage() {
  return (
    <>
      <JsonLd data={faqJsonLd(FAQ_DATA)} />
      <Hero />
      <Suspense fallback={<HomeSectionFallback label="Загружаем курсы" />}>
        <CourseGrid />
      </Suspense>
      <PartnersStrip />
      <ProcessTimeline />
      <Suspense fallback={<HomeSectionFallback label="Загружаем материалы" />}>
        <Resources />
      </Suspense>
      <Testimonials />
      <FaqAccordion />
      <ContactCta />
    </>
  );
}
