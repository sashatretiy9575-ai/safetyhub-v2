'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
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
    <div className="grid gap-2 sm:grid-cols-2">
      <ContactLink
        kind="phone"
        contacts={contacts}
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border-strong)] px-3 text-sm font-semibold transition hover:border-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
      >
        {t('callWithNumber', { phone: contacts.phoneDisplay })}
      </ContactLink>
      <ContactLink
        kind="whatsapp"
        contacts={contacts}
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-primary)]/45 bg-[var(--color-primary-soft)]/45 px-3 text-sm font-semibold text-[var(--color-primary)] transition hover:bg-[var(--color-primary-soft)] focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)]"
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
        className="border-y border-[var(--color-warning)]/55 bg-[var(--color-accent-amber-soft)]/35 px-4 py-4 sm:px-5"
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-warning)] uppercase">
              {t('accessEyebrow')}
            </p>
            <h2 id="approval-profile-title" className="font-display mt-1 text-xl font-bold">
              {t('profileTitle')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              {t('profileDescription')}
            </p>
          </div>
          <Button asChild size="sm">
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
        className="border-y border-[var(--color-danger)]/55 bg-[var(--color-danger-soft)]/35 px-4 py-4 sm:px-5"
      >
        <div className="space-y-3">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-danger)] uppercase">
              {t('rejectedEyebrow')}
            </p>
            <h2 id="approval-rejected-title" className="font-display mt-1 text-xl font-bold">
              {t('rejectedTitle')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              {t('rejectedDescription')}
            </p>
          </div>
          {rejectionReason ? (
            <p className="border-l-2 border-[var(--color-danger)]/60 pl-3 text-sm leading-6">
              <strong>{t('adminComment')}</strong> {rejectionReason}
            </p>
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
      className="border-y border-[var(--color-primary)]/55 bg-[var(--color-primary-soft)]/30 px-4 py-4 sm:px-5"
    >
      <div className="space-y-4">
        <div>
          <p className="text-xs font-bold tracking-wide text-[var(--color-primary)] uppercase">
            {t('pendingEyebrow')}
          </p>
          <h2 id="approval-pending-title" className="font-display mt-1 text-xl font-bold">
            {t('pendingTitle')}
          </h2>
          <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
            {t('pendingDescription')}
          </p>
        </div>
        {remaining === null ? (
          <p className="border-l-2 border-[var(--color-border-strong)] pl-3 text-sm">
            {t('pendingNoDue')}
          </p>
        ) : expired ? (
          <p
            role="status"
            className="border-l-2 border-[var(--color-warning)] pl-3 text-sm leading-6"
          >
            {t('overdue')}
          </p>
        ) : (
          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-y border-[var(--color-primary)]/20 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[var(--color-text-muted)]">
                {t('remaining')}
              </p>
              {dueLabel ? (
                <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                  {t('deadline', { deadline: dueLabel })}
                </p>
              ) : null}
              <p className="mt-1 text-xs text-[var(--color-text-subtle)]">{t('countdownHint')}</p>
            </div>
            <time
              dateTime={dueAt ?? undefined}
              role="timer"
              aria-label={t('remaining')}
              className="min-w-[6.5rem] text-right font-mono text-2xl font-bold tracking-wide text-[var(--color-primary)] tabular-nums"
            >
              {formatRemaining(remaining)}
            </time>
          </div>
        )}
        <ReviewContacts contacts={contacts} />
      </div>
    </section>
  );
}
