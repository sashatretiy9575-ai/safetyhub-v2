import { notFound, permanentRedirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { getTopicBySlug, getTopicRedirectBySlug, getTopicSlugs } from '@/lib/content/topics';
import { CourseMaterialActions } from '@/components/topics/course-material-actions';
import { JsonLd } from '@/components/shared/json-ld';
import { breadcrumbsJsonLd, buildMetadata, courseJsonLd } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { TopicSourcesCard } from '@/components/topics/topic-sources-card';
import { getAuthContext } from '@/features/auth/server';
import { localizePathname } from '@/i18n/config';

export const dynamic = 'force-dynamic';

export async function generateStaticParams() {
  return (await getTopicSlugs()).map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const locale = await getLocale();
  const [topic, t] = await Promise.all([getTopicBySlug(slug, locale), getTranslations('Topics')]);
  if (!topic) return {};

  return buildMetadata({
    title: topic.seo.title,
    description: topic.seo.description,
    ogTitle: topic.seo.ogTitle,
    ogDescription: topic.seo.ogDescription,
    ogImage: topic.seo.ogImage || '/opengraph-image',
    noindex: !topic.seo.indexable,
    path: `/topics/${slug}`,
    type: 'article',
    keywords: [topic.title, t('seoKeyword')],
    locale,
  });
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [locale, t, courseT, footerT] = await Promise.all([
    getLocale(),
    getTranslations('Topics'),
    getTranslations('Course'),
    getTranslations('Shell.footer'),
  ]);

  const topic = await getTopicBySlug(slug, locale);
  if (!topic) {
    const destination = await getTopicRedirectBySlug(slug);
    if (destination) permanentRedirect(localizePathname(`/topics/${destination}`, locale));
    if (slug === 'industrial-safety') permanentRedirect(localizePathname('/topics', locale));
    if (slug === 'fire-safety')
      permanentRedirect(localizePathname('/topics/pozharnaya-bezopasnost', locale));
    if (slug === 'occupational-health') permanentRedirect(localizePathname('/topics/biot', locale));
    notFound();
  }

  const auth = await getAuthContext();
  const access = !auth
    ? 'anonymous'
    : !auth.hasCurrentLegalAcceptance
      ? 'legal_required'
      : auth.approval.state;

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
            locationName: footerT('city'),
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
      <CourseMaterialActions course={topic} access={access} />
      <TopicSourcesCard topic={topic} />
    </>
  );
}
