import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getTopicLocales, getTopicBySlug, getTopicRedirectBySlug, getTopicSlugs } from '@/server/content/topics';
import { CourseMaterialActions } from '@/components/topics/course-material-actions';
import { JsonLd } from '@/components/shared/json-ld';
import { breadcrumbsJsonLd, buildMetadata, courseJsonLd } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { TopicSourcesCard } from '@/components/topics/topic-sources-card';
import { localizePathname } from '@/i18n/config';
import { getCourseCoverImage } from '@/lib/content/course-cover-images';
import { resolveCourseIcon } from '@/lib/content/course-icons';

export const revalidate = 300;

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const locale = await getLocale();
  const [topic, t, courseT] = await Promise.all([
    getTopicBySlug(slug, locale),
    getTranslations('Topics'),
    getTranslations('Course'),
  ]);
  if (!topic)
    // Without this the layout's canonical is inherited and a missing course
    // declares itself to be the home page.
    return { robots: { index: false, follow: false }, alternates: { canonical: null } };

  // An editor who filled in the SEO title is trusted; when the field is empty
  // `defaultContentSeo` copies the course name verbatim, and a title that is one
  // trade name plus the brand is not what anyone searches for.
  const usesRawTitle = topic.seo.title === topic.title;
  const seoTitle = usesRawTitle ? courseT('pageHeading', { course: topic.title }) : topic.seo.title;
  return buildMetadata({
    title: seoTitle,
    description: topic.seo.description,
    ogTitle: usesRawTitle ? seoTitle : topic.seo.ogTitle,
    ogDescription: topic.seo.ogDescription,
    ogImage: topic.seo.ogImage || '/opengraph-image',
    noindex: !topic.seo.indexable,
    path: `/topics/${slug}`,
    // A course page is a catalogue entry, not a publication: `article` asks for
    // article:published_time it cannot supply and contradicts the Course graph
    // on the same page.
    type: 'website',
    keywords: [topic.title, t('seoKeyword')],
    locale,
    // Only the locales this document was actually published in. Announcing all
    // four pointed hreflang at URLs that do not exist.
    availableLocales: await getTopicLocales(slug),
  });
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [locale, t, courseT] = await Promise.all([
    getLocale(),
    getTranslations('Topics'),
    getTranslations('Course'),
  ]);

  const topic = await getTopicBySlug(slug, locale);
  if (!topic) {
    const destination = await getTopicRedirectBySlug(slug);
    if (destination) permanentRedirect(localizePathname(`/topics/${destination}`, locale));
    if (slug === 'industrial-safety')
      permanentRedirect(localizePathname('/topics/promyshlennaya-bezopasnost', locale));
    if (slug === 'fire-safety')
      permanentRedirect(localizePathname('/topics/pozharnaya-bezopasnost', locale));
    if (slug === 'occupational-health') permanentRedirect(localizePathname('/topics/biot', locale));
    notFound();
  }

  const courseIcon = resolveCourseIcon(topic.icon);
  const CourseIcon = courseIcon.component;

  return (
    <>
      <JsonLd
        data={[
          courseJsonLd({
            name: topic.title,
            description: topic.description,
            url: absoluteUrl(localizePathname(`/topics/${topic.slug}`, locale)),
            locale,
            credentialName: courseT('credentialAwarded'),
            durationMinutes: topic.durationMinutes,
            image: getCourseCoverImage(topic.slug, locale, topic.seo.ogImage),
          }),
          breadcrumbsJsonLd([
            { name: t('breadcrumbHome'), url: absoluteUrl(localizePathname('/', locale)) },
            { name: t('breadcrumbCourses'), url: absoluteUrl(localizePathname('/topics', locale)) },
            {
              name: topic.title,
              url: absoluteUrl(localizePathname(`/topics/${topic.slug}`, locale)),
            },
          ]),
        ]}
      />
      {/*
       * Public course HTML deliberately stays generic. Personal approval and
       * legal state are only resolved on private, no-store routes after an
       * explicit interaction; looking at an auth cookie here would make the
       * public page uncacheable at the CDN.
       */}
      <CourseMaterialActions course={topic} access="anonymous" iconSlot={<CourseIcon size={30} weight="duotone" aria-hidden="true" />} />
      <TopicSourcesCard topic={topic} />
    </>
  );
}
