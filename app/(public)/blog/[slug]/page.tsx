import Image from 'next/image';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  Clock,
  UserCircle,
} from '@phosphor-icons/react/dist/ssr';
import type { Metadata } from 'next';
import {
  ArticleRenderer,
  estimateArticleReadTime,
  getArticleToc,
  type ArticleTocItem,
} from '@/components/article-renderer';
import { ArticleCard } from '@/components/marketing/article-card';
import { JsonLd } from '@/components/shared/json-ld';
import { Container } from '@/components/ui/container';
import {
  getArticleBySlug,
  getArticleRedirectBySlug,
  getArticles,
  getArticleSlugs,
  type Article,
} from '@/lib/content/articles';
import { articleJsonLd, breadcrumbsJsonLd, buildMetadata } from '@/lib/seo';
import { absoluteUrl } from '@/lib/utils';
import { getSiteContacts } from '@/lib/site-contacts';

export async function generateStaticParams() {
  return (await getArticleSlugs()).map((slug) => ({ slug }));
}

function formatDate(value: string | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await getArticleBySlug(slug);
  if (!article) return {};
  return buildMetadata({
    title: article.seo?.title ?? article.title,
    description: article.seo?.description ?? article.description,
    ogTitle: article.seo?.ogTitle,
    ogDescription: article.seo?.ogDescription,
    path: `/blog/${slug}`,
    ogImage: article.seo?.ogImage || article.coverImage || '/opengraph-image',
    noindex: article.seo ? !article.seo.indexable : false,
    type: 'article',
    publishedTime: article.createdAt,
    modifiedTime: article.updatedAt,
  });
}

function TocLinks({ items }: { items: ArticleTocItem[] }) {
  return (
    <ol className="mt-3 space-y-2 text-sm">
      {items.map((item) => (
        <li key={item.id} className={item.level === 3 ? 'pl-3' : item.level === 4 ? 'pl-6' : ''}>
          <a
            href={`#${item.id}`}
            className="block rounded-md py-1 text-[var(--color-text-muted)] no-underline transition-colors hover:text-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
          >
            {item.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

function ArticleSources({ article }: { article: Article }) {
  const sourceCount = article.sources?.length ?? 0;

  return (
    <details
      id="article-sources"
      className="group mt-10 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-muted)]"
    >
      <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-4 px-4 py-2.5 font-bold marker:content-none md:px-5 [&::-webkit-details-marker]:hidden">
        <span>Нормативные источники ({sourceCount})</span>
        <span
          aria-hidden="true"
          className="text-xl text-[var(--color-primary)] transition-transform group-open:rotate-45"
        >
          +
        </span>
      </summary>
      <div className="border-t border-[var(--color-border)] px-4 py-4 md:px-5">
        {sourceCount > 0 ? (
          <ol className="space-y-3">
            {article.sources.map((source) => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-[var(--color-primary-hover)] underline underline-offset-4"
                >
                  {source.title}
                </a>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-[var(--color-text-muted)]">
            Для этой версии материала нормативные источники пока не указаны.
          </p>
        )}
      </div>
    </details>
  );
}

function RelatedArticles({ articles }: { articles: Omit<Article, 'blocks'>[] }) {
  if (articles.length === 0) return null;
  return (
    <section
      aria-labelledby="related-articles-title"
      className="mt-16 border-t border-[var(--color-border)] pt-10 md:mt-20 md:pt-12"
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold tracking-[0.18em] text-[var(--color-primary)] uppercase">
            Продолжить чтение
          </p>
          <h2
            id="related-articles-title"
            className="font-display mt-1 text-2xl font-bold md:text-3xl"
          >
            Ещё по делу
          </h2>
        </div>
        <Link
          href="/blog"
          className="inline-flex min-h-11 items-center gap-1 rounded-full bg-[var(--color-primary-soft)] px-4 font-bold text-[var(--color-primary-hover)] transition hover:bg-[var(--color-primary)] hover:text-[var(--color-primary-foreground)]"
        >
          Весь блог <ArrowRight aria-hidden="true" size={16} />
        </Link>
      </div>
      <div className="mt-6 grid items-stretch gap-5 md:grid-cols-3">
        {articles.map((related) => (
          <ArticleCard
            key={related.slug}
            slug={related.slug}
            title={related.title}
            description={related.description}
            coverImage={related.coverImage}
          />
        ))}
      </div>
    </section>
  );
}

export default async function BlogArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [article, allArticles, contacts] = await Promise.all([
    getArticleBySlug(slug),
    getArticles(),
    getSiteContacts(),
  ]);

  if (!article) {
    const destination = await getArticleRedirectBySlug(slug);
    if (destination) permanentRedirect(`/blog/${destination}`);
    notFound();
  }

  const toc = getArticleToc(article.blocks);
  const readTime = estimateArticleReadTime(article.blocks);
  const relatedArticles = allArticles.filter((item) => item.slug !== article.slug).slice(0, 3);
  const author = article.author ?? 'Редакция SafetyHub';
  const publishedDate = formatDate(article.createdAt);
  const showToc = toc.length >= 4 && readTime >= 2;

  const schemas: object[] = [
    breadcrumbsJsonLd([
      { name: 'Главная', url: absoluteUrl('/') },
      { name: 'Блог', url: absoluteUrl('/blog') },
      { name: article.title, url: absoluteUrl(`/blog/${article.slug}`) },
    ]),
  ];
  if (article.createdAt) {
    schemas.unshift(
      articleJsonLd({
        headline: article.title,
        description: article.description,
        image: article.coverImage || '/opengraph-image',
        datePublished: article.createdAt,
        dateModified: article.updatedAt,
        author,
        url: absoluteUrl(`/blog/${article.slug}`),
      }),
    );
  }

  return (
    <>
      <JsonLd data={schemas} />
      <article className="py-6 md:py-14">
        <Container size="wide">
          <Link
            href="/blog"
            className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-primary)]"
          >
            <ArrowLeft aria-hidden="true" size={16} weight="bold" />
            Все статьи
          </Link>

          <div
            data-article-region="hero"
            className="mx-auto mt-4 grid max-w-[70rem] items-stretch gap-6 overflow-hidden rounded-[30px] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-card)] sm:p-7 md:mt-7 lg:grid-cols-[minmax(0,1.25fr)_minmax(19rem,0.75fr)] lg:gap-10 lg:p-9"
          >
            <header className="flex min-w-0 flex-col justify-center text-left">
              <p className="inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-[var(--color-primary)] uppercase sm:text-xs">
                <span
                  className="size-2 rounded-full bg-[var(--color-primary)]"
                  aria-hidden="true"
                />
                Практическое руководство
              </p>
              <h1 className="font-display mt-3 text-[30px] leading-[1.16] font-black tracking-[-0.035em] text-balance sm:text-[38px] lg:text-[48px]">
                {article.title}
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-pretty text-[var(--color-text-muted)] sm:text-lg">
                {article.description}
              </p>
              <dl className="mt-6 flex flex-wrap justify-start gap-2 text-xs text-[var(--color-text-muted)] sm:text-sm">
                <div className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-surface-muted)] px-3">
                  <UserCircle aria-hidden="true" size={18} />
                  <dt className="sr-only">Автор</dt>
                  <dd>{author}</dd>
                </div>
                {publishedDate ? (
                  <div className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-surface-muted)] px-3">
                    <CalendarBlank aria-hidden="true" size={18} />
                    <dt className="sr-only">Дата публикации</dt>
                    <dd>{publishedDate}</dd>
                  </div>
                ) : null}
                <div className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-[var(--color-primary-soft)] px-3 text-[var(--color-primary-hover)]">
                  <Clock aria-hidden="true" size={18} />
                  <dt className="sr-only">Время чтения</dt>
                  <dd>{readTime} мин чтения</dd>
                </div>
              </dl>
            </header>

            {article.coverImage ? (
              <figure className="relative aspect-[16/9] min-h-0 overflow-hidden rounded-[22px] bg-[var(--color-surface-soft)] lg:aspect-[4/3] lg:max-h-[27rem]">
                <Image
                  src={article.coverImage}
                  alt=""
                  aria-hidden="true"
                  fill
                  priority
                  sizes="(max-width: 1023px) 92vw, 420px"
                  className="object-cover"
                />
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/20 to-transparent"
                />
              </figure>
            ) : (
              <div
                className="hidden rounded-[22px] bg-[var(--color-primary-soft)] lg:block"
                aria-hidden="true"
              />
            )}
          </div>

          {showToc ? (
            <details
              data-article-region="toc"
              className="group mx-auto mt-8 max-w-[70rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-soft)]"
            >
              <summary className="flex min-h-13 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 font-bold marker:content-none md:px-6 [&::-webkit-details-marker]:hidden">
                <span>Оглавление</span>
                <span
                  aria-hidden="true"
                  className="text-xl text-[var(--color-primary)] transition-transform group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <nav aria-label="Оглавление статьи">
                <div className="border-t border-[var(--color-border)] px-4 py-4 md:px-6">
                  <TocLinks items={toc} />
                </div>
              </nav>
            </details>
          ) : null}

          <div data-article-region="body" className="mx-auto mt-10 max-w-[70rem] md:mt-12">
            <ArticleRenderer blocks={article.blocks} contacts={contacts} />
            <ArticleSources article={article} />
          </div>

          <RelatedArticles articles={relatedArticles} />
        </Container>
      </article>
    </>
  );
}
