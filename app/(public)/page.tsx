import { getLocale, getTranslations } from 'next-intl/server';
import { Hero } from '@/components/marketing/hero';
import { PartnersStrip } from '@/components/marketing/partners-strip';
import { CourseGrid } from '@/components/marketing/course-grid';
import { ProcessTimeline } from '@/components/marketing/process-timeline';
import { Testimonials } from '@/components/marketing/testimonials';
import { Resources } from '@/components/marketing/resources';
import { FaqAccordion } from '@/components/marketing/faq-accordion';
import { ContactCta } from '@/components/marketing/contact-cta';
import { QUIZ_POLICY } from '@/lib/constants';
import { buildMetadata } from '@/lib/seo';

export async function generateMetadata() {
  const t = await getTranslations('Home');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription', {
      count: QUIZ_POLICY.questionCount,
      pass: QUIZ_POLICY.passScore,
    }),
    path: '/',
    locale: await getLocale(),
  });
}

/**
 * The page is prerendered, so the course grid and the articles are ready
 * before the first byte. Suspense boundaries around them bought nothing: React
 * printed skeletons in their place and moved the real sections after the
 * footer, revealing them at least 300 ms apart and leaving them hidden from
 * anything that reads the HTML without running JavaScript.
 */
export default function HomePage() {
  return (
    <>
      {/* The FAQPage graph belongs to /faq. Emitting the identical one here as
          well described the same questions at two URLs from one source. */}
      <Hero />
      <CourseGrid />
      <PartnersStrip />
      <ProcessTimeline />
      <Resources />
      <Testimonials />
      <FaqAccordion withContact={false} />
      <ContactCta />
    </>
  );
}
