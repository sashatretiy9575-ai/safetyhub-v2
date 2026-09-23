import { ArrowUpRight, Clock, ListChecks } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import Link from 'next/link';
import { resolveCourseIcon } from '@/lib/content/course-icons';
import { useLocale, useTranslations } from 'next-intl';
import { localizePathname } from '@/i18n/config';
import { CARD_BLUR_PLACEHOLDER } from '@/components/marketing/shared/card-blur-placeholder';

type CourseCardProps = {
  slug: string;
  title: string;
  /** One or two lines about the course; the title alone read as an empty card. */
  description?: string;
  coverImage?: string;
  icon?: string;
  durationMinutes: number;
  questionCount: number;
  pageCount?: number;
  priority?: boolean;
};

export function CourseCard({
  slug,
  title,
  description,
  coverImage,
  icon,
  durationMinutes,
  questionCount,
  pageCount,
  priority = false,
}: CourseCardProps) {
  const locale = useLocale();
  const t = useTranslations('Course');
  const courseIcon = resolveCourseIcon(icon);
  const CourseIcon = courseIcon.component;
  return (
    <Link
      data-course-card
      href={localizePathname(`/topics/${slug}`, locale)}
      // Eight cards in view prefetched eight course pages (~20 KB each) right
      // after load, competing with the covers on a phone.
      prefetch={false}
      className="group flex h-full flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/90 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)] focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] motion-safe:hover:-translate-y-0.5"
    >
      <div
        data-course-card-cover
        // Two cards a row on a phone: the 16:9 cover of a half-width card is
        // about 95px tall, so a screen shows four courses, not one.
        className="relative aspect-video shrink-0 overflow-hidden bg-[var(--color-surface-muted)]"
      >
        {coverImage ? (
          <Image
            src={coverImage}
            alt=""
            fill
            // The grid is capped at 1280 px, so above that the slot stops growing with
            // the viewport and a vw hint overstates it.
            sizes="(min-width: 1280px) 312px, (min-width: 768px) 33vw, (min-width: 360px) 50vw, 100vw"
            priority={priority}
            loading={priority ? undefined : 'lazy'}
            placeholder="blur"
            blurDataURL={CARD_BLUR_PLACEHOLDER}
            className="absolute inset-0 size-full object-cover transition-transform duration-500 motion-safe:group-hover:scale-[1.03]"
          />
        ) : (
          <div
            className="absolute inset-0 grid place-items-center bg-[linear-gradient(135deg,var(--color-primary-soft),var(--color-surface-muted))] text-[var(--color-primary)]"
            aria-hidden="true"
          >
            <CourseIcon size={64} weight="duotone" />
          </div>
        )}
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/30 to-transparent"
        />
        <span
          className="absolute top-2 right-2 grid size-8 place-items-center rounded-xl border border-white/55 bg-white/85 text-slate-700 shadow-sm backdrop-blur-md sm:top-3 sm:right-3 sm:size-9"
          title={title}
        >
          <CourseIcon size={20} weight="duotone" aria-hidden="true" />
          <span className="sr-only">{title}</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-3 sm:p-5">
        <h3 className="sm:text-title line-clamp-2 text-sm leading-snug font-bold [overflow-wrap:anywhere]">
          {title}
        </h3>
        {description ? (
          <p className="mt-1.5 line-clamp-2 text-sm leading-snug text-[var(--color-text-muted)] max-sm:text-xs sm:mt-2 sm:leading-relaxed">
            {description}
          </p>
        ) : null}

        <div
          data-course-card-actions
          className="mt-auto grid grid-cols-2 gap-2 pt-3 text-xs font-semibold text-[var(--color-text-muted)] sm:pt-4"
        >
          <span
            aria-label={t('questions', { count: questionCount })}
            className="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[12px] bg-[var(--color-surface-muted)] px-2.5 max-sm:hidden"
          >
            <ListChecks
              size={16}
              weight="duotone"
              className="text-[var(--color-primary)]"
              aria-hidden="true"
            />
            <span className="min-[280px]:hidden" aria-hidden="true">
              {questionCount}
            </span>
            <span className="hidden min-[280px]:inline" aria-hidden="true">
              {t('questions', { count: questionCount })}
            </span>
          </span>
          <span
            aria-label={`${t('minutes', { count: durationMinutes })}${pageCount ? `, ${t('pages', { count: pageCount })}` : ''}`}
            className="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[12px] bg-[var(--color-surface-muted)] px-2.5 max-sm:hidden"
          >
            <Clock
              size={16}
              weight="duotone"
              className="text-[var(--color-primary)]"
              aria-hidden="true"
            />
            <span aria-hidden="true">
              {t('minutesShort', { count: durationMinutes })}
              {pageCount ? ` · ${t('pagesShort', { count: pageCount })}` : ''}
            </span>
          </span>
          <span
            data-course-card-cta
            aria-label={t('open')}
            // 44px is the minimum comfortable tap target; this was 40px.
            className="col-span-2 inline-flex min-h-11 min-w-0 items-center justify-between gap-2 rounded-[14px] bg-[var(--color-primary)] px-3 text-xs font-bold whitespace-nowrap text-[var(--color-primary-foreground)] shadow-[0_10px_24px_-16px_var(--color-primary)] transition-colors group-hover:bg-[var(--color-primary-hover)] sm:mt-1 sm:gap-3 sm:px-4 sm:text-sm"
          >
            <span aria-hidden="true">{t('open')}</span>
            <ArrowUpRight
              size={16}
              weight="bold"
              className="shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 sm:size-[18px]"
              aria-hidden="true"
            />
          </span>
        </div>
      </div>
    </Link>
  );
}
