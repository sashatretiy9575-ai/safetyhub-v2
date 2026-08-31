import Image from 'next/image';
import { ArrowRight, BookOpenText } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { cn } from '@/lib/utils';

const CARD_BLUR_PLACEHOLDER =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2225%22 viewBox=%220 0 40 25%22%3E%3Crect width=%2240%22 height=%2225%22 fill=%22%23eef1ef%22/%3E%3C/svg%3E';

type ArticleCardProps = {
  slug: string;
  title: string;
  description: string;
  coverImage?: string;
  priority?: boolean;
  featured?: boolean;
};

export function ArticleCard({
  slug,
  title,
  description,
  coverImage,
  priority = false,
  featured = false,
}: ArticleCardProps) {
  return (
    <Link
      href={`/blog/${slug}`}
      className={cn(
        'group flex h-full min-w-0 flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[0_16px_40px_-30px_rgba(15,23,18,0.34)] transition duration-300 hover:border-[var(--color-primary)]/45 hover:shadow-[var(--shadow-card)] focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] motion-safe:hover:-translate-y-1',
        featured &&
          'min-[1100px]:col-span-2 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.1fr)]',
      )}
    >
      <div
        className={cn(
          'relative aspect-[16/8] shrink-0 overflow-hidden bg-[var(--color-surface-muted)]',
          featured && 'min-[1100px]:aspect-auto',
        )}
      >
        {coverImage ? (
          <Image
            src={coverImage}
            alt=""
            fill
            priority={priority}
            loading={priority ? undefined : 'lazy'}
            placeholder="blur"
            blurDataURL={CARD_BLUR_PLACEHOLDER}
            sizes={
              featured
                ? '(max-width: 599px) 92vw, (max-width: 1099px) 48vw, 36vw'
                : '(max-width: 599px) 82vw, (max-width: 1199px) 46vw, 33vw'
            }
            quality={76}
            className="object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.025]"
          />
        ) : (
          <div className="grid size-full place-items-center bg-[var(--color-primary-soft)] text-sm font-bold text-[var(--color-primary)]">
            SafetyHub
          </div>
        )}
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/25 to-transparent"
        />
      </div>

      <div
        className={cn('flex min-w-0 flex-1 flex-col p-5 sm:p-6', featured && 'min-[1100px]:p-8')}
      >
        <p className="mb-3 inline-flex items-center gap-2 text-[11px] font-bold tracking-[0.13em] text-[var(--color-primary)] uppercase sm:text-xs">
          <BookOpenText size={16} weight="bold" aria-hidden="true" />
          Практическое руководство
        </p>
        <h3
          className={cn(
            'text-[18px] leading-[1.28] font-bold tracking-[-0.02em] text-balance transition-colors group-hover:text-[var(--color-primary-hover)] sm:text-xl',
            featured && 'min-[1100px]:text-[28px] min-[1100px]:leading-[1.22]',
          )}
        >
          {title}
        </h3>
        <p
          className={cn(
            'mt-3 text-sm leading-6 text-[var(--color-text-muted)]',
            featured && 'min-[1100px]:text-base min-[1100px]:leading-7',
          )}
        >
          {description}
        </p>
        <span className="mt-6 inline-flex min-h-11 w-fit items-center gap-2 rounded-full bg-[var(--color-primary-soft)] px-4 text-sm font-bold text-[var(--color-primary-hover)] transition-colors group-hover:bg-[var(--color-primary)] group-hover:text-[var(--color-primary-foreground)]">
          Читать статью
          <ArrowRight
            size={17}
            weight="bold"
            className="transition-transform motion-safe:group-hover:translate-x-1"
            aria-hidden="true"
          />
        </span>
      </div>
    </Link>
  );
}
