'use client';

import Link from 'next/link';
import { WarningCircle, ArrowClockwise, House } from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { reportAppError } from '@/lib/observability';
import { localizePathname, type AppLocale } from '@/i18n/config';

export function AppPageLoading() {
  const t = useTranslations('AppState');
  return (
    <div
      className="rounded-3xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-[var(--shadow-soft)]"
      role="status"
      aria-live="polite"
      aria-label={t('loadingAria')}
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="h-5 w-32 rounded-full bg-[var(--color-surface-muted)]" />
          <div className="h-10 w-3/4 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-4 w-1/2 rounded-full bg-[var(--color-surface-muted)]" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
          <div className="h-32 rounded-2xl bg-[var(--color-surface-muted)]" />
        </div>
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--color-primary)]" />
          {t('loading')}
        </div>
      </div>
    </div>
  );
}

type AppDiagnostic = ReturnType<typeof reportAppError>;

type AppErrorStateProps = {
  title: string;
  description: string;
  error?: Error;
  diagnostic?: AppDiagnostic | null;
  onRetry?: () => void;
  retryLabel?: string;
  homeLabel?: string;
  correlationLabel: string;
  compact?: boolean;
};

export function AppErrorState({
  title,
  description,
  error,
  diagnostic: providedDiagnostic,
  onRetry,
  retryLabel,
  homeLabel,
  correlationLabel,
  compact = false,
}: AppErrorStateProps) {
  const locale = useLocale() as AppLocale;
  const common = useTranslations('Common');
  const diagnostic = providedDiagnostic ?? (error ? reportAppError(error, { source: 'app-error-state' }) : null);
  const resolvedRetryLabel = retryLabel ?? common('retry');
  const resolvedHomeLabel = homeLabel ?? common('home');

  return (
    <div
      className={`mx-auto w-full max-w-2xl rounded-3xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-6 text-center shadow-[var(--shadow-soft)] ${compact ? 'max-w-xl' : ''}`}
      role="alert"
    >
      <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-[var(--color-danger)]/10 text-[var(--color-danger)]">
        <WarningCircle className="size-7" />
      </div>
      <div className="mt-5 space-y-3">
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-[var(--color-text-muted)]">{description}</p>
        {diagnostic ? (
          <p className="break-all font-mono text-xs text-[var(--color-text-subtle)]">
            {correlationLabel}: {diagnostic.correlationId}
          </p>
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        {onRetry ? (
          <Button type="button" onClick={onRetry} className="min-h-11">
            <span className="mr-2 inline-flex items-center">
              <ArrowClockwise size={16} />
            </span>
            {resolvedRetryLabel}
          </Button>
        ) : null}
        <Button asChild variant="outline" className="min-h-11">
          <Link href={localizePathname('/', locale)}>
            <span className="mr-2 inline-flex items-center">
              <House size={16} />
            </span>
            {resolvedHomeLabel}
          </Link>
        </Button>
      </div>
    </div>
  );
}
