import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, CheckCircle, Info, Quotes, Warning } from '@phosphor-icons/react/dist/ssr';
import { Button } from '@/components/ui/button';
import { Carousel } from '@/components/ui/carousel';
import { ContactLink } from '@/components/shared/contact-link';
import type { ArticleBlock } from '@/lib/content/articles';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import { ARTICLE_WHATSAPP_ACTION_URL, articleBlocksSchema } from '@/lib/validation/article';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';

interface ArticleRendererProps {
  blocks: unknown;
  contacts?: SiteContactSettings;
}

export type ArticleTocItem = {
  blockIndex: number;
  id: string;
  title: string;
  level: 2 | 3 | 4;
};

function headingSlug(value: string) {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

export function getArticleToc(blocks: unknown): ArticleTocItem[] {
  const parsed = articleBlocksSchema.safeParse(blocks);
  if (!parsed.success) return [];
  const occurrences = new Map<string, number>();
  const items: ArticleTocItem[] = [];
  parsed.data.forEach((block, blockIndex) => {
    if (block.type !== 'heading') return;
    const base = headingSlug(block.content);
    const count = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, count);
    items.push({
      blockIndex,
      id: count === 1 ? base : `${base}-${count}`,
      title: block.content,
      level: block.level,
    });
  });
  return items;
}

function blockText(block: ArticleBlock): string[] {
  switch (block.type) {
    case 'paragraph':
    case 'heading':
    case 'quote':
      return [block.content];
    case 'callout':
      return [block.title ?? '', block.content];
    case 'button':
      return [block.text];
    case 'image':
      return [block.alt, block.caption ?? ''];
    case 'slider':
      return block.images.flatMap((image) => [image.alt, image.caption ?? '']);
    case 'list':
      return block.items;
    case 'table':
      return [block.caption ?? '', ...block.headers, ...block.rows.flat()];
    case 'source':
      return [block.title, block.note ?? ''];
    case 'divider':
      return [];
  }
}

export function estimateArticleReadTime(blocks: unknown) {
  const parsed = articleBlocksSchema.safeParse(blocks);
  if (!parsed.success) return 1;
  const words =
    parsed.data
      .flatMap(blockText)
      .join(' ')
      .match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(words / 180));
}

const calloutStyles = {
  info: {
    icon: Info,
    className: 'border-[var(--color-primary)]/35 bg-[var(--color-primary-soft)]',
  },
  warning: {
    icon: Warning,
    className: 'border-[var(--color-warning)]/40 bg-[var(--color-accent-amber-soft)]',
  },
  success: {
    icon: CheckCircle,
    className: 'border-[var(--color-success)]/35 bg-[var(--color-primary-soft)]',
  },
} as const;

export function ArticleRenderer({ blocks, contacts }: ArticleRendererProps) {
  const t = useTranslations('Blog');
  const result = articleBlocksSchema.safeParse(blocks);
  if (!result.success) {
    return (
      <div
        role="alert"
        className="rounded-[var(--radius-md)] border border-[var(--color-danger)]/35 bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]"
      >
        {t('articleUnavailable')}
      </div>
    );
  }

  const validBlocks = result.data;
  const headingIds = new Map(getArticleToc(validBlocks).map((item) => [item.blockIndex, item.id]));

  return (
    <div className="prose-blog min-w-0 text-[15.5px] leading-[1.78] text-[var(--color-text-muted)] sm:text-[17px] lg:text-[18px]">
      {validBlocks.map((block, index) => {
        switch (block.type) {
          case 'paragraph':
            return (
              <p key={index} className="my-5 leading-[1.78] text-pretty">
                {block.content}
              </p>
            );

          case 'heading': {
            const Tag = `h${block.level}` as 'h2' | 'h3' | 'h4';
            return (
              <Tag
                key={index}
                id={headingIds.get(index)}
                className={cn(
                  'scroll-mt-24 text-balance text-[var(--color-text)]',
                  block.level === 2 &&
                    'mt-12 mb-4 text-[24px] leading-[1.24] font-extrabold sm:text-[30px]',
                  block.level === 3 && 'mt-9 mb-3 text-xl leading-[1.3] font-bold sm:text-[24px]',
                  block.level === 4 && 'mt-7 mb-3 text-lg leading-[1.35] font-bold',
                )}
              >
                {block.content}
              </Tag>
            );
          }

          case 'image':
            return (
              <figure key={index} className="my-7">
                <div className="relative aspect-video overflow-hidden rounded-[var(--radius-lg)] bg-[var(--color-surface-soft)]">
                  <Image
                    src={block.src}
                    alt={block.decorative ? '' : block.alt}
                    aria-hidden={block.decorative || undefined}
                    fill
                    sizes="(max-width: 767px) 100vw, (max-width: 1279px) calc(100vw - 3rem), 1120px"
                    className="object-cover"
                    loading="lazy"
                  />
                </div>
                {block.caption ? (
                  <figcaption className="mt-2 text-center text-xs text-[var(--color-text-subtle)]">
                    {block.caption}
                  </figcaption>
                ) : null}
              </figure>
            );

          case 'button': {
            const buttonClass =
              block.style === 'outline'
                ? 'min-h-13 w-full justify-between rounded-[var(--radius-md)] px-5 text-base font-bold shadow-sm sm:w-auto sm:min-w-72 dark:border-white/50 dark:bg-white/5 dark:text-white dark:hover:bg-white/15'
                : 'min-h-13 w-full justify-between rounded-[var(--radius-md)] px-5 text-base font-bold !text-white no-underline shadow-[var(--color-primary)]/20 shadow-lg hover:no-underline sm:w-auto sm:min-w-72';
            return (
              <div key={index} className="my-10 flex justify-start">
                <Button
                  asChild
                  size="xl"
                  variant={block.style === 'outline' ? 'outline' : 'primary'}
                  className={buttonClass}
                >
                  {block.url === ARTICLE_WHATSAPP_ACTION_URL && contacts ? (
                    <ContactLink kind="whatsapp" contacts={contacts} data-article-cta>
                      {block.text}
                      <ArrowRight size={18} weight="bold" aria-hidden="true" />
                    </ContactLink>
                  ) : (
                    <Link href={block.url} data-article-cta>
                      {block.text}
                      <ArrowRight size={18} weight="bold" aria-hidden="true" />
                    </Link>
                  )}
                </Button>
              </div>
            );
          }

          case 'slider':
            return (
              <Carousel
                key={index}
                label={block.label ?? t('gallery', { count: index + 1 })}
                className="my-7"
                gridClassName="md:grid-cols-2"
                itemClassName="min-w-[92%] min-[420px]:min-w-[82%]"
                itemLabel={t('image')}
                previousLabel={t('previousImage')}
                nextLabel={t('nextImage')}
              >
                {block.images.map((galleryImage, imageIndex) => (
                  <figure key={`${galleryImage.src}-${imageIndex}`} className="min-w-0">
                    <div className="relative aspect-video overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-surface-soft)]">
                      <Image
                        src={galleryImage.src}
                        alt={galleryImage.decorative ? '' : galleryImage.alt}
                        aria-hidden={galleryImage.decorative || undefined}
                        fill
                        sizes="(max-width: 767px) 88vw, (max-width: 1279px) 46vw, 540px"
                        className="object-cover"
                        loading="lazy"
                      />
                    </div>
                    {galleryImage.caption ? (
                      <figcaption className="mt-2 text-sm text-[var(--color-text-muted)]">
                        {galleryImage.caption}
                      </figcaption>
                    ) : null}
                  </figure>
                ))}
              </Carousel>
            );

          case 'quote':
            return (
              <blockquote
                key={index}
                className="my-7 flex gap-3 rounded-[var(--radius-md)] border-l-4 border-[var(--color-primary)] bg-[var(--color-primary-soft)] p-4"
              >
                <Quotes
                  size={24}
                  weight="fill"
                  aria-hidden="true"
                  className="mt-0.5 shrink-0 text-[var(--color-primary)]"
                />
                <p className="my-0 text-[var(--color-text-muted)] italic">{block.content}</p>
              </blockquote>
            );

          case 'list': {
            const isOrdered = block.style === 'ordered';
            const List = isOrdered ? 'ol' : 'ul';
            return (
              <List
                key={index}
                className={cn(
                  'my-6 space-y-2 leading-7 pl-6',
                  isOrdered ? 'list-decimal' : 'list-disc',
                )}
              >
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="pl-1 text-[var(--color-text)]">
                    {item}
                  </li>
                ))}
              </List>
            );
          }

          case 'table':
            return (
              <div
                key={index}
                role="region"
                aria-label={block.caption ?? t('table', { count: index + 1 })}
                tabIndex={0}
                className="my-7 w-full overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]"
              >
                <table className="w-full text-left text-sm sm:text-[15px]">
                  {block.caption ? (
                    <caption className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/50 px-4 py-2 text-left text-xs font-bold text-[var(--color-text-muted)]">
                      {block.caption}
                    </caption>
                  ) : null}
                  <thead>
                    <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface-muted)]/70">
                      {block.headers.map((header, headerIndex) => (
                        <th
                          key={headerIndex}
                          scope="col"
                          className="px-4 py-3 text-xs font-bold uppercase tracking-wide text-[var(--color-text-muted)]"
                        >
                          {header}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr
                        key={rowIndex}
                        className="border-t border-[var(--color-border)] transition-colors hover:bg-[var(--color-surface-muted)]/40"
                      >
                        {row.map((cell, cellIndex) => (
                          <td
                            key={cellIndex}
                            className="px-4 py-3 leading-relaxed text-[var(--color-text)]"
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );

          case 'callout': {
            const style = calloutStyles[block.tone];
            const Icon = style.icon;
            const defaultLabel =
              block.tone === 'info'
                ? t('info')
                : block.tone === 'warning'
                  ? t('important')
                  : t('recommendation');
            return (
              <aside
                key={index}
                aria-label={block.title ?? defaultLabel}
                className={cn(
                  'my-7 flex gap-3 rounded-[var(--radius-md)] border p-4 sm:p-5',
                  style.className,
                )}
              >
                <Icon aria-hidden="true" size={22} className="mt-0.5 shrink-0" />
                <div className="min-w-0">
                  {block.title ? (
                    <p className="my-0 font-bold text-[var(--color-text)]">{block.title}</p>
                  ) : null}
                  <p className={block.title ? 'mt-2 mb-0' : 'my-0'}>{block.content}</p>
                </div>
              </aside>
            );
          }

          case 'source':
            return (
              <aside
                key={index}
                aria-label={t('source')}
                className="my-5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-4"
              >
                <p className="my-0 text-xs font-bold tracking-wider text-[var(--color-text-subtle)] uppercase">
                  {t('source')}
                </p>
                <a
                  href={block.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold"
                >
                  {block.title}
                </a>
                {block.note ? <p className="mb-0 text-sm">{block.note}</p> : null}
              </aside>
            );

          case 'divider':
            return <hr key={index} className="my-8 border-[var(--color-border)]" />;
        }
      })}
    </div>
  );
}
