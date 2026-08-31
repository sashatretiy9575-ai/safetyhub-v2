import {
  ArrowLeft,
  DownloadSimple,
  FilePdf,
  ListChecks,
  Timer,
} from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import { resolveCourseIcon } from '@/lib/course-icons';
import type { Course } from '@/lib/content/topics';
import { ROUTES } from '@/lib/constants';

function presentationDownloadUrl(url: string, slug: string) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}download=${encodeURIComponent(`${slug}.pdf`)}`;
}

export function CourseMaterialActions({ course }: { course: Course }) {
  const courseIcon = resolveCourseIcon(course.icon);
  const CourseIcon = courseIcon.component;
  const filename = `${course.slug}.pdf`;

  return (
    <section className="py-8 sm:py-12 lg:py-14">
      <Container size="content">
        <Link
          href={ROUTES.topics}
          prefetch={false}
          className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-1 text-sm font-semibold text-[var(--color-text-muted)] transition hover:text-[var(--color-primary)]"
        >
          <ArrowLeft size={18} weight="bold" aria-hidden="true" />
          Все курсы
        </Link>

        <Card className="overflow-hidden">
          <CardContent className="p-6 sm:p-8 lg:p-10">
            <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
              <div className="min-w-0">
                <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                  <CourseIcon size={30} weight="duotone" aria-hidden="true" />
                </div>
                <p className="text-xs font-bold tracking-[0.16em] text-[var(--color-primary)] uppercase">
                  Онлайн-курс
                </p>
                <h1 className="mt-2 text-3xl leading-tight font-black tracking-[-0.035em] sm:text-4xl">
                  {course.title}
                </h1>
                <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--color-text-muted)] sm:text-base">
                  {course.description}
                </p>

                <div className="mt-6 flex flex-wrap gap-2 text-xs font-semibold text-[var(--color-text-muted)] sm:text-sm">
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <FilePdf size={18} weight="duotone" className="text-[var(--color-primary)]" />
                    {course.presentation?.pageCount ?? 0} страниц
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <ListChecks
                      size={18}
                      weight="duotone"
                      className="text-[var(--color-primary)]"
                    />
                    {course.questionCount} вопросов
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <Timer size={18} weight="duotone" className="text-[var(--color-primary)]" />
                    {course.durationMinutes} минут
                  </span>
                </div>
              </div>

              <div data-course-material-actions className="grid w-full gap-3">
                {course.presentation ? (
                  <Button asChild variant="secondary" size="xl" className="w-full">
                    <a
                      href={presentationDownloadUrl(course.presentation.url, course.slug)}
                      download={filename}
                    >
                      <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                      Скачать презентацию
                    </a>
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="xl" className="w-full" disabled>
                    <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                    Презентация недоступна
                  </Button>
                )}

                <Button asChild size="xl" className="w-full">
                  <Link href={ROUTES.test(course.slug)} prefetch={false}>
                    <ListChecks size={20} weight="bold" aria-hidden="true" />
                    Начать тест
                  </Link>
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
