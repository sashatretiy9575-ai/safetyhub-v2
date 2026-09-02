'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
import { ClockCountdown, HourglassMedium } from '@phosphor-icons/react';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import {
  BUSINESS_TIME_ZONE,
  HTML_LANGUAGE_BY_LOCALE,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';

type ApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

function formatRemaining(milliseconds: number) {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  return [hours, minutes % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatDueAt(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(HTML_LANGUAGE_BY_LOCALE[locale], {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BUSINESS_TIME_ZONE,
  }).format(new Date(value));
}


function ReviewContacts({ contacts }: { contacts: SiteContactSettings }) {
  const t = useTranslations('Approval');
  return (
    <div className="grid gap-3 sm:grid-cols-2 pt-2">
      <ContactLink
        kind="phone"
        contacts={contacts}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--color-primary)] hover:shadow-xs focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
      >
        {t('callWithNumber', { phone: contacts.phoneDisplay })}
      </ContactLink>
      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 px-4 py-2.5 text-sm font-semibold transition hover:bg-emerald-500/20 hover:shadow-xs focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
      >
        {t('whatsapp')}
      </ContactLink>
    </div>
  );
}

export function AccountApprovalStatus({
  state,
  dueAt,
  rejectionReason,
  contacts,
}: {
  state: ApprovalState;
  dueAt: string | null;
  rejectionReason: string | null;
  contacts: SiteContactSettings;
}) {
  const locale = useLocale() as AppLocale;
  const t = useTranslations('Approval');
  const dueTimestamp = useMemo(() => {
    if (!dueAt) return null;
    const parsed = Date.parse(dueAt);
    return Number.isFinite(parsed) ? parsed : null;
  }, [dueAt]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== 'pending' || dueTimestamp === null) return undefined;
    let timer: number | undefined;

    const syncAtMinuteBoundary = () => {
      const current = Date.now();
      setNow(current);

      const remaining = dueTimestamp - current;
      if (remaining <= 0) return;

      // The visible clock is HH:MM, so it only needs to update when that value changes.
      const untilNextMinute = remaining % 60_000 || 1;
      timer = window.setTimeout(syncAtMinuteBoundary, Math.max(100, untilNextMinute + 16));
    };

    syncAtMinuteBoundary();
    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [dueTimestamp, state]);

  if (state === 'approved') return null;

  if (state === 'profile_incomplete') {
    return (
      <section
        aria-labelledby="approval-profile-title"
        className="rounded-2xl border border-[var(--color-warning)]/40 bg-[var(--color-accent-amber-soft)]/20 p-6 sm:p-7 shadow-xs"
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-warning)] uppercase">
              {t('accessEyebrow')}
            </p>
            <h2 id="approval-profile-title" className="font-display mt-1 text-xl sm:text-2xl font-black">
              {t('profileTitle')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)] max-w-2xl">
              {t('profileDescription')}
            </p>
          </div>
          <Button asChild size="lg">
            <Link href={localizePathname('/onboarding', locale)}>{t('profileAction')}</Link>
          </Button>
        </div>
      </section>
    );
  }

  if (state === 'rejected') {
    return (
      <section
        aria-labelledby="approval-rejected-title"
        className="rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)]/20 p-6 sm:p-7 shadow-xs"
      >
        <div className="space-y-4">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-danger)] uppercase">
              {t('rejectedEyebrow')}
            </p>
            <h2 id="approval-rejected-title" className="font-display mt-1 text-xl sm:text-2xl font-black">
              {t('rejectedTitle')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)] max-w-2xl">
              {t('rejectedDescription')}
            </p>
          </div>
          {rejectionReason ? (
            <div className="rounded-xl border-l-4 border-[var(--color-danger)] bg-[var(--color-surface)]/80 p-4 text-sm leading-relaxed">
              <strong>{t('adminComment')}</strong> {rejectionReason}
            </div>
          ) : null}
          <ReviewContacts contacts={contacts} />
        </div>
      </section>
    );
  }

  const remaining = dueTimestamp === null ? null : dueTimestamp - now;
  const expired = remaining !== null && remaining <= 0;
  const dueLabel = dueAt && dueTimestamp !== null ? formatDueAt(dueAt, locale) : null;

  return (
    <section
      aria-labelledby="approval-pending-title"
      className="relative overflow-hidden rounded-2xl border border-[var(--color-primary)]/25 bg-gradient-to-br from-[var(--color-primary-soft)]/20 via-[var(--color-surface)] to-[var(--color-surface)] p-6 sm:p-8 shadow-xs"
    >
      <div className="relative space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-primary)]/15 text-[var(--color-primary)]">
              <HourglassMedium size={26} weight="duotone" className="animate-pulse" />
              <span className="absolute -top-0.5 -right-0.5 flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--color-primary)] opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-[var(--color-primary)]" />
              </span>
            </div>
            <div>
              <p className="text-xs font-bold tracking-wider text-[var(--color-primary)] uppercase">
                {t('pendingEyebrow')}
              </p>
              <h2 id="approval-pending-title" className="font-display text-xl sm:text-2xl font-black text-[var(--color-text)]">
                {t('pendingTitle')}
              </h2>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 self-start sm:self-auto rounded-full bg-[var(--color-primary)]/10 px-3.5 py-1.5 text-xs font-bold text-[var(--color-primary)] border border-[var(--color-primary)]/20">
            <span className="h-2 w-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
            <span>{t('pendingEyebrow')}</span>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-[var(--color-text-muted)] max-w-2xl">
          {t('pendingDescription')}
        </p>

        {/* 3-step progress track */}
        <div className="grid grid-cols-3 gap-2 sm:gap-4 rounded-xl bg-[var(--color-surface-muted)]/60 p-3 sm:p-4 border border-[var(--color-border)]">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-xs font-bold mb-1.5">
              ✓
            </div>
            <span className="text-[11px] sm:text-xs font-semibold text-[var(--color-text)]">1</span>
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">{t('profileAction')}</span>
          </div>
          <div className="flex flex-col items-center text-center">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-primary)] text-white text-xs font-bold mb-1.5 shadow-xs">
              2
            </div>
            <span className="text-[11px] sm:text-xs font-bold text-[var(--color-primary)]">2</span>
            <span className="text-[10px] text-[var(--color-primary)] font-semibold">{t('pendingEyebrow')}</span>
          </div>
          <div className="flex flex-col items-center text-center opacity-60">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--color-border)] text-[var(--color-text-muted)] text-xs font-bold mb-1.5">
              3
            </div>
            <span className="text-[11px] sm:text-xs font-semibold text-[var(--color-text-muted)]">3</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">{t('accessEyebrow')}</span>
          </div>
        </div>

        {/* Timer countdown box */}
        {remaining === null ? (
          <div className="rounded-xl border border-[var(--color-border-strong)]/40 bg-[var(--color-surface)]/70 p-4">
            <p className="text-sm font-medium text-[var(--color-text-muted)]">
              {t('pendingNoDue')}
            </p>
          </div>
        ) : expired ? (
          <div
            role="status"
            className="rounded-xl border border-[var(--color-warning)]/60 bg-[var(--color-accent-amber-soft)]/20 p-4"
          >
            <p className="text-sm font-semibold text-[var(--color-warning)]">
              {t('overdue')}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-surface)]/80 backdrop-blur-xs p-4 sm:p-5 shadow-xs">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <ClockCountdown size={18} weight="duotone" className="text-[var(--color-primary)]" />
                <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
                  {t('remaining')}
                </p>
              </div>
              {dueLabel ? (
                <p className="mt-1 text-sm font-semibold text-[var(--color-text)]">
                  {t('deadline', { deadline: dueLabel })}
                </p>
              ) : null}
              <p className="mt-0.5 text-xs text-[var(--color-text-subtle)]">{t('countdownHint')}</p>
            </div>
            <div className="flex flex-col items-end">
              <time
                dateTime={dueAt ?? undefined}
                role="timer"
                aria-label={t('remaining')}
                className="font-mono text-3xl sm:text-4xl font-black tracking-tight text-[var(--color-primary)] tabular-nums"
              >
                {formatRemaining(remaining)}
              </time>
            </div>
          </div>
        )}

        <div className="pt-1">
          <ReviewContacts contacts={contacts} />
        </div>
      </div>
    </section>
  );
}
