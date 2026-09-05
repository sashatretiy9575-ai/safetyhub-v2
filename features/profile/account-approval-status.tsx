'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
import { ClockCountdown } from '@phosphor-icons/react/dist/csr/ClockCountdown';
import { HourglassMedium } from '@phosphor-icons/react/dist/csr/HourglassMedium';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import {
  BUSINESS_TIME_ZONE,
  HTML_LANGUAGE_BY_LOCALE,
  localizePathname,
  type AppLocale,
} from '@/i18n/config';

type ApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

function formatRemaining(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
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
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-2.5 text-sm font-semibold transition hover:border-[var(--color-primary)] hover:shadow-sm focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
      >
        {t('callWithNumber', { phone: contacts.phoneDisplay })}
      </ContactLink>
      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[var(--color-primary)]/45 bg-[var(--color-primary-soft)]/45 px-4 py-2.5 text-sm font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary-soft)] hover:shadow-sm focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
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
        className="rounded-2xl border border-[var(--color-warning)]/40 bg-[var(--color-accent-amber-soft)]/20 p-6 sm:p-7 shadow-sm"
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
        className="rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)]/20 p-6 sm:p-7 shadow-sm"
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
      className="relative overflow-hidden rounded-2xl border border-[var(--color-primary)]/40 bg-[var(--color-surface)] p-6 sm:p-8 shadow-sm"
    >
      <div className="relative space-y-5">
        <div className="flex items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
            <HourglassMedium size={26} weight="duotone" className="animate-pulse" />
          </div>
          <div>
            <h2 id="approval-pending-title" className="font-display text-xl sm:text-2xl font-black text-[var(--color-text)]">
              {t('pendingTitle')}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-text-muted)] max-w-2xl">
              {t('pendingDescription')}
            </p>
          </div>
        </div>

        {remaining === null ? (
          <p className="text-sm font-medium text-[var(--color-text-muted)]">{t('pendingNoDue')}</p>
        ) : expired ? (
          <p role="status" className="text-sm font-semibold text-[var(--color-warning)]">
            {t('overdue')}
          </p>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--color-primary)]/20 bg-[var(--color-surface)] p-4 sm:p-5 shadow-sm">
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
            </div>
            <time
              dateTime={dueAt ?? undefined}
              role="timer"
              aria-live="off"
              aria-label={t('remaining')}
              className="font-mono text-2xl sm:text-3xl font-black tracking-tight text-[var(--color-primary)] tabular-nums"
            >
              {t('remainingValue', formatRemaining(remaining))}
            </time>
          </div>
        )}

        <ReviewContacts contacts={contacts} />
      </div>
    </section>
  );
}
