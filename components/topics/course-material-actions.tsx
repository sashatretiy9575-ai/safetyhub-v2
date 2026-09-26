'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr/ArrowLeft';
import { CircleNotch } from '@phosphor-icons/react/dist/ssr/CircleNotch';
import { DownloadSimple } from '@phosphor-icons/react/dist/ssr/DownloadSimple';
import { FilePdf } from '@phosphor-icons/react/dist/ssr/FilePdf';
import { ListChecks } from '@phosphor-icons/react/dist/ssr/ListChecks';
import { Timer } from '@phosphor-icons/react/dist/ssr/Timer';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Container } from '@/components/ui/container';
import type { Course } from '@/server/content/topics';
import { ROUTES } from '@/lib/constants';
import { useLocale, useTranslations } from 'next-intl';
import { localizePathname } from '@/i18n/config';
import { rememberRequestedCourse } from '@/lib/profile/requested-courses';

export type CourseMaterialAccess =
  | 'anonymous'
  | 'legal_required'
  | 'profile_incomplete'
  | 'pending'
  | 'rejected'
  | 'course_locked'
  | 'approved';

function presentationDownloadUrl(url: string, slug: string) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}download=${encodeURIComponent(`${slug}.pdf`)}`;
}

/**
 * A presentation is tens of megabytes and the route leases it before the first
 * byte arrives, so a plain link sat there doing nothing visible for seconds and
 * people pressed it again. The file is read here instead, so the button can say
 * how far along it is; the browser still saves it the moment it is whole.
 */
function usePresentationDownload(url: string | undefined, filename: string) {
  const [state, setState] = useState<'idle' | 'working' | 'failed' | 'done'>('idle');
  const [percent, setPercent] = useState(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    if (!url || state === 'working') return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setState('working');
    setPercent(0);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('PRESENTATION_DOWNLOAD_FAILED');
      const total = Number(response.headers.get('content-length') ?? 0);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        // Without a length the share is unknown; the button then counts megabytes.
        if (total > 0) setPercent(Math.min(99, Math.round((received / total) * 100)));
      }
      const href = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = href;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 30_000);
      setPercent(100);
      setState('done');
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error('PRESENTATION_DOWNLOAD_FAILED', error);
      setState('failed');
    }
  };

  return { state, percent, start };
}

type AccessCopy = Record<
  Exclude<CourseMaterialAccess, 'approved'>,
  { title: string; description: string; label: string }
>;

function accessCta(
  access: CourseMaterialAccess,
  slug: string,
  locale: ReturnType<typeof useLocale>,
  copy: AccessCopy,
) {
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

// Keyed by course: since access is granted per course, one course's answer
// says nothing about the next one the visitor opens.
const cachedClientAccess = new Map<string, CourseMaterialAccess>();
const cachedRequested = new Set<string>();

/** Where a signed-in person without the course stands: they chose it, it goes to the administrator. */
const RECORDED_STATES: ReadonlySet<CourseMaterialAccess> = new Set([
  'legal_required',
  'profile_incomplete',
  'pending',
]);

async function sendCourseRequest(slug: string) {
  const response = await fetch('/api/profile/course-access-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!response.ok) throw new Error('COURSE_ACCESS_REQUEST_FAILED');
  const data = (await response.json()) as { status?: string };
  return data.status;
}

export function CourseMaterialActions({
  course,
  access,
  iconSlot,
}: {
  course: Course;
  access: CourseMaterialAccess;
  iconSlot?: React.ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations('Course');
  const [currentAccess, setCurrentAccess] = useState<CourseMaterialAccess>(
    () => cachedClientAccess.get(course.slug) ?? access,
  );
  const [isResolving, setIsResolving] = useState(
    () => !cachedClientAccess.has(course.slug) && access === 'anonymous',
  );
  const [request, setRequest] = useState<'idle' | 'sending' | 'sent' | 'failed'>(() =>
    cachedRequested.has(course.slug) ? 'sent' : 'idle',
  );

  useEffect(() => {
    let active = true;
    if (access === 'anonymous') {
      fetch(`/api/auth/access?course=${encodeURIComponent(course.slug)}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (active && data?.access) {
            cachedClientAccess.set(course.slug, data.access);
            setCurrentAccess(data.access);
            if (data.requested === true) {
              cachedRequested.add(course.slug);
              setRequest('sent');
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (active) {
            setIsResolving(false);
          }
        });
    } else {
      cachedClientAccess.set(course.slug, access);
      setCurrentAccess(access);
      setIsResolving(false);
    }
    return () => {
      active = false;
    };
  }, [access, course.slug]);

  // A newcomer who opened this course has chosen it: it is recorded quietly,
  // so the approval queue ticks it for the administrator.
  useEffect(() => {
    if (!RECORDED_STATES.has(currentAccess)) return;
    void sendCourseRequest(course.slug).catch(() => undefined);
  }, [currentAccess, course.slug]);

  const requestAccess = async () => {
    if (request === 'sending' || request === 'sent') return;
    setRequest('sending');
    try {
      const status = await sendCourseRequest(course.slug);
      if (status === 'granted') {
        cachedClientAccess.set(course.slug, 'approved');
        setCurrentAccess('approved');
        return;
      }
      cachedRequested.add(course.slug);
      setRequest('sent');
    } catch {
      setRequest('failed');
    }
  };

  const filename = `${course.slug}.pdf`;
  const download = usePresentationDownload(
    course.presentation ? presentationDownloadUrl(course.presentation.url, course.slug) : undefined,
    filename,
  );
  const downloading = download.state === 'working';
  const lockedCopy =
    request === 'sent'
      ? { title: t('access.requestedTitle'), description: t('access.requestedDescription') }
      : { title: t('access.lockedTitle'), description: t('access.lockedDescription') };
  const cta = accessCta(currentAccess, course.slug, locale, {
    anonymous: {
      title: t('access.anonymousTitle'),
      description: t('access.anonymousDescription'),
      label: t('access.anonymousLabel'),
    },
    legal_required: {
      title: t('access.legalTitle'),
      description: t('access.legalDescription'),
      label: t('access.legalLabel'),
    },
    profile_incomplete: {
      title: t('access.profileTitle'),
      description: t('access.profileDescription'),
      label: t('access.profileLabel'),
    },
    pending: {
      title: t('access.pendingTitle'),
      description: t('access.pendingDescription'),
      label: t('access.pendingLabel'),
    },
    rejected: {
      title: t('access.rejectedTitle'),
      description: t('access.rejectedDescription'),
      label: t('access.rejectedLabel'),
    },
    course_locked: { ...lockedCopy, label: t('access.lockedLabel') },
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
                  {iconSlot ?? <FilePdf size={30} weight="duotone" aria-hidden="true" />}
                </div>
                <p className="text-xs font-bold tracking-widest text-[var(--color-primary)] uppercase">
                  {t('online')}
                </p>
                <h1 className="text-h2 mt-2 font-black">
                  {t('pageHeading', { course: course.title })}
                </h1>
                {/* A course summary is two or three lines; at `leading-7` on 14px
                    text they stood twice their own height apart and the block read
                    as a wall rather than a sentence. */}
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--color-text-muted)] sm:text-base">
                  {course.description}
                </p>

                <div className="mt-6 flex flex-wrap gap-2 text-xs font-semibold text-[var(--color-text-muted)] sm:text-sm">
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <FilePdf
                      aria-hidden="true"
                      size={18}
                      weight="duotone"
                      className="text-[var(--color-primary)]"
                    />
                    {t('pages', { count: course.presentation?.pageCount ?? 0 })}
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <ListChecks
                      aria-hidden="true"
                      size={18}
                      weight="duotone"
                      className="text-[var(--color-primary)]"
                    />
                    {t('questions', { count: course.questionCount })}
                  </span>
                  <span className="inline-flex min-h-10 items-center gap-2 rounded-full bg-[var(--color-surface-muted)] px-3.5">
                    <Timer
                      aria-hidden="true"
                      size={18}
                      weight="duotone"
                      className="text-[var(--color-primary)]"
                    />
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
                    <h2 className="font-sans text-base leading-6 font-bold">{cta.title}</h2>
                    <p className="text-sm leading-6 text-[var(--color-text-muted)]">
                      {cta.description}
                    </p>
                    {currentAccess === 'course_locked' ? (
                      request === 'sent' ? null : (
                        <Button
                          type="button"
                          size="lg"
                          className="w-full"
                          aria-busy={request === 'sending'}
                          disabled={request === 'sending'}
                          onClick={requestAccess}
                        >
                          {request === 'sending' ? t('access.requestSending') : cta.label}
                        </Button>
                      )
                    ) : (
                      <Button asChild size="lg" className="w-full">
                        <Link
                          href={cta.href}
                          onClick={
                            currentAccess === 'anonymous'
                              ? () => rememberRequestedCourse(course.slug)
                              : undefined
                          }
                        >
                          {cta.label}
                        </Link>
                      </Button>
                    )}
                    {request === 'failed' ? (
                      <p role="alert" className="text-sm text-[var(--color-danger)]">
                        {t('access.requestFailed')}
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <>
                    {course.presentation ? (
                      <div className="grid gap-1.5">
                        <Button
                          type="button"
                          variant="secondary"
                          size="xl"
                          className="w-full"
                          aria-busy={downloading}
                          disabled={downloading}
                          onClick={download.start}
                        >
                          {downloading ? (
                            <CircleNotch
                              size={20}
                              weight="bold"
                              aria-hidden="true"
                              className="motion-safe:animate-spin"
                            />
                          ) : (
                            <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                          )}
                          {downloading
                            ? download.percent > 0
                              ? t('downloadProgress', { percent: download.percent })
                              : t('downloadPreparing')
                            : t('downloadPresentation')}
                        </Button>
                        {/* The progress is spoken as well as drawn: the button's own
                            label changes, and this line reports the end of it. */}
                        <p
                          aria-live="polite"
                          className={
                            'min-h-5 text-center text-xs font-semibold ' +
                            (download.state === 'failed'
                              ? 'text-[var(--color-danger)]'
                              : 'text-[var(--color-text-muted)]')
                          }
                        >
                          {download.state === 'failed'
                            ? t('downloadFailed')
                            : download.state === 'done'
                              ? t('downloadDone')
                              : ''}
                        </p>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="secondary"
                        size="xl"
                        className="w-full"
                        disabled
                      >
                        <DownloadSimple size={20} weight="bold" aria-hidden="true" />
                        {t('presentationUnavailable')}
                      </Button>
                    )}

                    <Button asChild size="xl" className="w-full">
                      <Link href={localizePathname(ROUTES.test(course.slug), locale)}>
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
