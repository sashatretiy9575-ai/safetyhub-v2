import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  getTopicLocales,
  getTopicBySlug,
  getTopicRedirectBySlug,
  getTopicSlugs,
  getTopics,
} from '@/server/content/topics';
import { getArticles } from '@/server/content/articles';
import { TopicRelatedLinks } from '@/components/topics/topic-related-links';
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
  const [topic, t, courseT, availableLocales] = await Promise.all([
    getTopicBySlug(slug, locale),
    getTranslations('Topics'),
    getTranslations('Course'),
    getTopicLocales(slug),
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
    // The course's own title slide, in the page's language, before the one
    // generic site card that every course used to share.
    ogImage: topic.seo.ogImage || getCourseCoverImage(slug, locale) || '/opengraph-image',
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
    availableLocales,
  });
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [locale, t, courseT] = await Promise.all([
    getLocale(),
    getTranslations('Topics'),
    getTranslations('Course'),
  ]);

  // The catalogue and the articles feed the related links below; they are
  // cached reads, so asking for them alongside the course costs nothing when
  // the course turns out to be missing.
  const [topic, catalogue, articles] = await Promise.all([
    getTopicBySlug(slug, locale),
    getTopics(locale),
    getArticles(locale),
  ]);
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
  // The next three courses of the catalogue (wrapping round) and the three
  // latest articles, in the page's language.
  const at = catalogue.findIndex((course) => course.slug === topic.slug);
  const relatedCourses = [...catalogue.slice(at + 1), ...catalogue.slice(0, Math.max(at, 0))]
    .filter((course) => course.slug !== topic.slug)
    .slice(0, 3)
    .map(({ slug: courseSlug, title }) => ({ slug: courseSlug, title }));
  const relatedArticles = articles
    .slice(0, 3)
    .map(({ slug: articleSlug, title }) => ({ slug: articleSlug, title }));

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
      <TopicRelatedLinks locale={locale} courses={relatedCourses} articles={relatedArticles} />
    </>
  );
}
