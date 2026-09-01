'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ContactLink } from '@/components/shared/contact-link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { SiteContactSettings } from '@/lib/site-contacts-shared';
import { localizePathname, type AppLocale } from '@/i18n/config';

type ApprovalState = 'profile_incomplete' | 'pending' | 'approved' | 'rejected';

function formatRemaining(milliseconds: number) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
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
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[#128c4a]/45 px-3 text-sm font-semibold text-[#128c4a] transition hover:bg-[#128c4a]/10 focus-visible:outline-[3px] focus-visible:outline-offset-3 focus-visible:outline-[var(--color-focus)] dark:text-[#39dc7a]"
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
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [dueTimestamp, state]);

  if (state === 'approved') return null;

  if (state === 'profile_incomplete') {
    return (
      <Card className="border-[var(--color-warning)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-warning)] uppercase">
              {t('accessEyebrow')}
            </p>
            <h2 className="font-display mt-1 text-xl font-bold">{t('profileTitle')}</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              {t('profileDescription')}
            </p>
          </div>
          <Button asChild size="sm">
            <Link href={localizePathname('/onboarding', locale)}>{t('profileAction')}</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (state === 'rejected') {
    return (
      <Card className="border-[var(--color-danger)]">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div>
            <p className="text-xs font-bold tracking-wide text-[var(--color-danger)] uppercase">
              {t('rejectedEyebrow')}
            </p>
            <h2 className="font-display mt-1 text-xl font-bold">{t('rejectedTitle')}</h2>
            <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
              {t('rejectedDescription')}
            </p>
          </div>
          {rejectionReason ? (
            <p className="rounded-xl bg-[var(--color-danger)]/10 p-3 text-sm leading-6">
              <strong>{t('adminComment')}</strong> {rejectionReason}
            </p>
          ) : null}
          <ReviewContacts contacts={contacts} />
        </CardContent>
      </Card>
    );
  }

  const remaining = dueTimestamp === null ? null : dueTimestamp - now;
  const expired = remaining !== null && remaining <= 0;

  return (
    <Card className="border-[var(--color-primary)]">
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div>
          <p className="text-xs font-bold tracking-wide text-[var(--color-primary)] uppercase">
            {t('pendingEyebrow')}
          </p>
          <h2 className="font-display mt-1 text-xl font-bold">{t('pendingTitle')}</h2>
          <p className="mt-1 text-sm leading-6 text-[var(--color-text-muted)]">
            {t('pendingDescription')}
          </p>
        </div>
        {remaining === null ? (
          <p className="rounded-xl bg-[var(--color-surface-muted)] p-3 text-sm">
            {t('pendingNoDue')}
          </p>
        ) : expired ? (
          <p className="rounded-xl bg-[var(--color-accent-amber-soft)] p-3 text-sm leading-6">
            {t('overdue')}
          </p>
        ) : (
          <div className="rounded-xl bg-[var(--color-primary-soft)] p-3">
            <p className="text-xs font-semibold text-[var(--color-text-muted)]">
              {t('remaining')}
            </p>
            <p aria-live="polite" className="mt-1 font-mono text-2xl font-bold tracking-wide text-[var(--color-primary)]">
              {formatRemaining(remaining)}
            </p>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              {t('countdownHint')}
            </p>
          </div>
        )}
        <ReviewContacts contacts={contacts} />
      </CardContent>
    </Card>
  );
}
