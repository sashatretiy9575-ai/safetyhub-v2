'use client';

import Link from 'next/link';
import { WarningCircle, ArrowClockwise, House } from '@phosphor-icons/react';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { reportAppError } from '@/lib/observability';
import { localizePathname, type AppLocale } from '@/i18n/config';

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
  const diagnostic =
    providedDiagnostic ?? (error ? reportAppError(error, { source: 'app-error-state' }) : null);
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
          <p className="font-mono text-xs break-all text-[var(--color-text-subtle)]">
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
