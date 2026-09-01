'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';

type DataLoadFailureProps = {
  correlationId: string;
  message: string;
};

export function DataLoadFailure({ correlationId, message }: DataLoadFailureProps) {
  const router = useRouter();
  const t = useTranslations('AppState');
  const common = useTranslations('Common');

  return (
    <div
      role="alert"
      className="space-y-3 rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-soft)] p-4"
    >
      <div className="space-y-1">
        <p className="text-sm font-semibold text-[var(--color-danger)]">{message}</p>
        <p className="text-sm text-[var(--color-text-muted)]">
          {t('partialFailure')}
        </p>
        <p className="text-xs text-[var(--color-text-muted)]">
          {common('correlationId', { id: correlationId })}
        </p>
      </div>
      <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
        {t('retryLoad')}
      </Button>
    </div>
  );
}
