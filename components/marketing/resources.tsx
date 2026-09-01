import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { ArticleCard } from '@/components/marketing/article-card';
import { SectionHeading } from '@/components/marketing/_shared/section-heading';
import { Container } from '@/components/ui/container';
import { MarketingSlider } from '@/components/ui/marketing-slider';
import { ROUTES } from '@/lib/constants';
import { getArticles } from '@/lib/content/articles';
import { getLocale, getTranslations } from 'next-intl/server';
import { localizePathname } from '@/i18n/config';

export async function Resources() {
  const [locale, t] = await Promise.all([getLocale(), getTranslations('Home.resources')]);
  const posts = (await getArticles(locale)).slice(0, 3);

  return (
    <section
      aria-labelledby="resources-heading"
      className="relative overflow-hidden bg-[var(--color-surface-muted)]/30 py-10 sm:py-12 lg:py-16"
    >
      <div
        aria-hidden="true"
        className="absolute -top-20 right-[-8rem] size-64 rounded-full bg-[var(--color-primary-soft)]/75 blur-3xl"
      />
      <Container size="wide">
        <SectionHeading
          id="resources-heading"
          eyebrow={t('eyebrow')}
          title={t('title')}
          description={t('description')}
          action={
            <Link
              href={localizePathname(ROUTES.blog, locale)}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-[var(--color-primary)] px-5 text-sm font-bold text-[var(--color-primary-foreground)] shadow-[var(--shadow-card)] transition hover:bg-[var(--color-primary-hover)]"
            >
              {t('all')}
              <ArrowUpRight size={17} weight="bold" aria-hidden="true" />
            </Link>
          }
        />

        {posts.length > 0 ? (
          <MarketingSlider
            label={t('slider')}
            itemLabel={t('item')}
            className="mt-6 sm:mt-8"
          >
            {posts.map((post) => (
              <ArticleCard
                key={post.slug}
                slug={post.slug}
                title={post.title}
                description={post.description}
                coverImage={post.coverImage}
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
  );
}
