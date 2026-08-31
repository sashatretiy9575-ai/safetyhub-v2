import { ArrowUpRight, Clock, ListChecks } from '@phosphor-icons/react/dist/ssr';
import Image from 'next/image';
import Link from 'next/link';
import { resolveCourseIcon } from '@/lib/course-icons';

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
  const courseIcon = resolveCourseIcon(icon);
  const CourseIcon = courseIcon.component;
  return (
    <Link
      data-course-card
      href={`/topics/${slug}`}
      prefetch={false}
      className="group flex h-full flex-col overflow-hidden rounded-[24px] border border-[var(--color-border)] bg-[var(--color-surface)]/90 shadow-[0_16px_40px_-28px_rgba(15,23,18,0.28)] backdrop-blur-xl transition hover:border-[var(--color-primary)]/40 hover:shadow-[var(--shadow-card)] focus-visible:outline-[3px] focus-visible:outline-offset-4 focus-visible:outline-[var(--color-focus)] motion-safe:hover:-translate-y-0.5"
    >
      <div
        data-course-card-cover
        className="relative h-[10.625rem] shrink-0 overflow-hidden bg-[var(--color-surface-muted)] sm:h-36"
      >
        {coverImage ? (
          <Image
            src={coverImage}
            alt=""
            fill
            sizes="(min-width: 1200px) 33vw, (min-width: 640px) 50vw, 100vw"
            priority={priority}
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
        <span className="absolute top-3 left-3 rounded-full border border-white/55 bg-white/80 px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-slate-700 uppercase shadow-sm backdrop-blur-md">
          Онлайн-курс
        </span>
        <span
          className="absolute top-3 right-3 grid size-9 place-items-center rounded-xl border border-white/55 bg-white/85 text-slate-700 shadow-sm backdrop-blur-md"
          title={courseIcon.label}
        >
          <CourseIcon size={20} weight="duotone" aria-hidden="true" />
          <span className="sr-only">{courseIcon.label}</span>
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-5">
        <h3 className="line-clamp-2 text-[17px] leading-[1.3] font-bold tracking-[-0.02em] sm:text-lg">
          {title}
        </h3>

        <div
          data-course-card-actions
          className="mt-auto grid grid-cols-2 gap-1.5 pt-4 text-[10px] font-semibold text-[var(--color-text-muted)] min-[340px]:gap-2 min-[340px]:text-[11px] sm:text-xs"
        >
          <span
            aria-label={`${questionCount} вопросов`}
            className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-[12px] bg-[var(--color-surface-muted)] px-1.5 min-[340px]:gap-1.5 min-[340px]:px-2"
          >
            <ListChecks
              size={15}
              weight="duotone"
              className="text-[var(--color-primary)]"
              aria-hidden="true"
            />
            <span className="min-[280px]:hidden" aria-hidden="true">
              {questionCount}
            </span>
            <span className="hidden min-[280px]:inline" aria-hidden="true">
              {questionCount} вопросов
            </span>
          </span>
          <span
            aria-label={`${durationMinutes} минут${pageCount ? `, ${pageCount} страниц` : ''}`}
            className="inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-[12px] bg-[var(--color-surface-muted)] px-1.5 min-[340px]:gap-1.5 min-[340px]:px-2"
          >
            <Clock
              size={15}
              weight="duotone"
              className="text-[var(--color-primary)]"
              aria-hidden="true"
            />
            <span aria-hidden="true">
              {durationMinutes} мин{pageCount ? ` · ${pageCount} стр.` : ''}
            </span>
          </span>
          <span
            data-course-card-cta
            aria-label="Открыть курс"
            className="col-span-2 mt-1 inline-flex min-h-11 min-w-0 items-center justify-between gap-3 rounded-[14px] bg-[var(--color-primary)] px-4 text-sm font-bold whitespace-nowrap text-[var(--color-primary-foreground)] shadow-[0_10px_24px_-16px_var(--color-primary)] transition-colors group-hover:bg-[var(--color-primary-hover)]"
          >
            <span aria-hidden="true">Открыть курс</span>
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
