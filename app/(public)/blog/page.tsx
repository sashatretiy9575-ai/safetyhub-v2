import { Suspense } from 'react';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArticleCard } from '@/components/marketing/article-card';
import { Container } from '@/components/ui/container';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { JsonLd } from '@/components/shared/json-ld';
import { getArticles } from '@/lib/content/articles';
import { breadcrumbsJsonLd, buildMetadata } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { localizePathname } from '@/i18n/config';

export async function generateMetadata() {
  const t = await getTranslations('Blog');
  return buildMetadata({
    title: t('metadataTitle'),
    description: t('metadataDescription'),
    path: '/blog',
    keywords: [t('metadataKeyword1'), t('metadataKeyword2')],
    locale: await getLocale(),
  });
}

function ArticleGridSkeleton({ label }: { label: string }) {
  return (
    <div
      className="grid gap-5 min-[1100px]:grid-cols-3 sm:grid-cols-2 lg:gap-6"
      aria-label={label}
    >
      {Array.from({ length: 3 }, (_, index) => (
        <div
          key={index}
          className="min-h-[25rem] overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/70"
          aria-hidden="true"
        >
          <div className="aspect-[16/8] animate-pulse bg-[var(--color-surface-muted)]" />
          <div className="space-y-3 p-5">
            <div className="h-5 w-4/5 animate-pulse rounded bg-[var(--color-surface-muted)]" />
            <div className="h-4 w-full animate-pulse rounded bg-[var(--color-surface-muted)]" />
            <div className="h-4 w-2/3 animate-pulse rounded bg-[var(--color-surface-muted)]" />
          </div>
        </div>
      ))}
    </div>
  );
}

async function ArticlesGrid() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('Blog')]);
  const articles = await getArticles(locale);

  if (articles.length === 0) {
    return (
      <EmptyState
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    );
  }

  return (
    <div
      className="grid items-stretch gap-5 min-[1100px]:grid-cols-3 sm:grid-cols-2 lg:gap-6"
      aria-label={t('listAria')}
    >
      {articles.map((article, index) => (
        <ArticleCard
          key={article.slug}
          slug={article.slug}
          title={article.title}
          description={article.description}
          coverImage={article.coverImage}
          priority={false}
          featured={index === 0}
        />
      ))}
    </div>
  );
}

export default async function BlogPage() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('Blog')]);
  return (
    <>
      <JsonLd
        data={breadcrumbsJsonLd([
          { name: t('breadcrumbsHome'), url: absoluteUrl(localizePathname('/', locale)) },
          { name: t('breadcrumbsBlog'), url: absoluteUrl(localizePathname('/blog', locale)) },
        ])}
      />
      <PageHeader
        title={t('title')}
        description={t('description')}
        eyebrow={t('eyebrow')}
        variant="compact"
      />

      <section className="py-9 sm:py-12 lg:py-16">
        <Container size="wide">
          <h2 className="sr-only">{t('listTitle')}</h2>
          <Suspense fallback={<ArticleGridSkeleton label={t('loading')} />}>
            <ArticlesGrid />
          </Suspense>
        </Container>
      </section>
    </>
  );
}
