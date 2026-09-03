import { ArrowUpRight, Clock, ListChecks } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import Link from 'next/link';
import { resolveCourseIcon } from '@/lib/course-icons';
import { useLocale, useTranslations } from 'next-intl';
import { localizePathname } from '@/i18n/config';
import { CARD_BLUR_PLACEHOLDER } from '@/components/marketing/_shared/card-blur-placeholder';

type CourseCardProps = {
  slug: string;
  title: string;
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
      className="group flex h-full flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/90 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)] focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] motion-safe:hover:-translate-y-0.5"
    >
      <div
        data-course-card-cover
        // A phone gets a fixed 170px cover so five cards stay scannable; a
        // `aspect-video` cover grew past 200px on a 390px screen and made the
        // catalog one long scroll. Wider layouts keep the 16:9 proportion.
        className="relative h-[170px] shrink-0 overflow-hidden bg-[var(--color-surface-muted)] sm:aspect-video sm:h-auto"
      >
        {coverImage ? (
          <Image
            src={coverImage}
            alt=""
            fill
            sizes="(min-width: 1200px) 33vw, (min-width: 640px) 50vw, 100vw"
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
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-xl border border-white/55 bg-white/85 text-slate-700 shadow-sm backdrop-blur-md"
          title={title}
        >
          <CourseIcon size={20} weight="duotone" aria-hidden="true" />
          <span className="sr-only">{title}</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
        <h3 className="line-clamp-2 text-[17px] leading-[1.3] font-bold tracking-[-0.02em] sm:text-lg">
          {title}
        </h3>

        <div
          data-course-card-actions
          className="mt-auto grid grid-cols-2 gap-2 pt-4 text-xs font-semibold text-[var(--color-text-muted)]"
        >
          <span
            aria-label={t('questions', { count: questionCount })}
            className="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[12px] bg-[var(--color-surface-muted)] px-2.5"
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
            className="inline-flex min-h-10 min-w-0 items-center justify-center gap-1.5 rounded-[12px] bg-[var(--color-surface-muted)] px-2.5"
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
            className="col-span-2 mt-1 inline-flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[14px] bg-[var(--color-primary)] px-4 text-xs sm:text-sm font-bold whitespace-nowrap text-[var(--color-primary-foreground)] shadow-[0_10px_24px_-16px_var(--color-primary)] transition-colors group-hover:bg-[var(--color-primary-hover)]"
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
