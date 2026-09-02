'use client';

import { useEffect, useState } from 'react';
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
import { useLocale, useTranslations } from 'next-intl';
import { localizePathname } from '@/i18n/config';

export type CourseMaterialAccess =
  | 'anonymous'
  | 'legal_required'
  | 'profile_incomplete'
  | 'pending'
  | 'rejected'
  | 'approved';

function presentationDownloadUrl(url: string, slug: string) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}download=${encodeURIComponent(`${slug}.pdf`)}`;
}

type AccessCopy = Record<
  Exclude<CourseMaterialAccess, 'approved'>,
  { title: string; description: string; label: string }
>;

function accessCta(access: CourseMaterialAccess, slug: string, locale: ReturnType<typeof useLocale>, copy: AccessCopy) {
  if (access === 'approved') return null;
  if (access === 'anonymous') {
    const login = localizePathname('/auth/login', locale);
    return {
      ...copy.anonymous,
      href: `${login}?return=${encodeURIComponent(localizePathname(`/topics/${slug}`, locale))}`,
    };
  }
  const destination =
    access === 'legal_required'
        ? '/auth/legal'
        : access === 'profile_incomplete'
          ? '/onboarding'
          : '/profile';
  return {
    ...copy[access],
    href: localizePathname(destination, locale),
  };
}

export function CourseMaterialActions({
  course,
  access,
}: {
  course: Course;
  access: CourseMaterialAccess;
}) {
  const locale = useLocale();
  const t = useTranslations('Course');
  const [currentAccess, setCurrentAccess] = useState<CourseMaterialAccess>(access);
  const [isResolving, setIsResolving] = useState(() => access === 'anonymous');

  useEffect(() => {
    let active = true;
    if (access === 'anonymous') {
      fetch('/api/auth/access')
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (active && data?.access) {
            setCurrentAccess(data.access);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) {
            setIsResolving(false);
          }
        });
    } else {
      setCurrentAccess(access);
      setIsResolving(false);
    }
    return () => {
      active = false;
    };
  }, [access]);

  const courseIcon = resolveCourseIcon(course.icon);
  const CourseIcon = courseIcon.component;
  const filename = `${course.slug}.pdf`;
  const cta = accessCta(currentAccess, course.slug, locale, {
    anonymous: { title: t('access.anonymousTitle'), description: t('access.anonymousDescription'), label: t('access.anonymousLabel') },
    legal_required: { title: t('access.legalTitle'), description: t('access.legalDescription'), label: t('access.legalLabel') },
    profile_incomplete: { title: t('access.profileTitle'), description: t('access.profileDescription'), label: t('access.profileLabel') },
    pending: { title: t('access.pendingTitle'), description: t('access.pendingDescription'), label: t('access.pendingLabel') },
    rejected: { title: t('access.rejectedTitle'), description: t('access.rejectedDescription'), label: t('access.rejectedLabel') },
  });

  return (
    <section className="py-8 sm:py-12 lg:py-14">
      <Container size="content">
        <Link
          href={localizePathname(ROUTES.topics, locale)}
          prefetch={false}
          className="mb-5 inline-flex min-h-11 items-center gap-2 rounded-[var(--radius-control)] px-1 text-sm font-semibold text-[var(--color-text-muted)] transition hover:text-[var(--color-primary)]"
        >
          <ArrowLeft size={18} weight="bold" aria-hidden="true" />
          {t('all')}
        </Link>

        <Card className="overflow-hidden">
          <CardContent className="p-6 sm:p-8 lg:p-10">
            <div className="grid items-center gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-12">
              <div className="min-w-0">
                <div className="mb-5 grid size-14 place-items-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                  <CourseIcon size={30} weight="duotone" aria-hidden="true" />
                </div>
                <p className="text-xs font-bold tracking-[0.16em] text-[var(--color-primary)] uppercase">
                  {t('online')}
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
                    {t('pages', { count: course.presentation?.pageCount ?? 0 })}
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <ListChecks
                      size={18}
                      weight="duotone"
                      className="text-[var(--color-primary)]"
                    />
                    {t('questions', { count: course.questionCount })}
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <Timer size={18} weight="duotone" className="text-[var(--color-primary)]" />
                    {t('minutes', { count: course.durationMinutes })}
                  </span>
                </div>
              </div>

              <div data-course-material-actions className="grid w-full gap-3">
                {isResolving ? (
                  <div className="space-y-3">
                    <div className="h-14 w-full animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
                    <div className="h-14 w-full animate-pulse rounded-xl bg-[var(--color-surface-muted)]" />
                  </div>
                ) : cta ? (
                  <div className="space-y-3 rounded-xl border border-[var(--color-warning)] bg-[var(--color-surface-muted)] p-4 text-left">
                    <p className="font-bold">{cta.title}</p>
                    <p className="text-sm leading-6 text-[var(--color-text-muted)]">{cta.description}</p>
                    <Button asChild size="lg" className="w-full">
                      <Link href={cta.href} prefetch={false}>{cta.label}</Link>
                    </Button>
                  </div>
                ) : (
                  <>
                    {course.presentation ? (
                  <Button asChild variant="secondary" size="xl" className="w-full">
                    <a
                      href={presentationDownloadUrl(course.presentation.url, course.slug)}
                      download={filename}
                    >
                      <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                      {t('downloadPresentation')}
                    </a>
                  </Button>
                ) : (
                  <Button type="button" variant="secondary" size="xl" className="w-full" disabled>
                    <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                    {t('presentationUnavailable')}
                  </Button>
                    )}

                    <Button asChild size="xl" className="w-full">
                      <Link href={localizePathname(ROUTES.test(course.slug), locale)} prefetch={false}>
                        <ListChecks size={20} weight="bold" aria-hidden="true" />
                        {t('startTest')}
                      </Link>
                    </Button>
                  </>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </Container>
    </section>
  );
}
