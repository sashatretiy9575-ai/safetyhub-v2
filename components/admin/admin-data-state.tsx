'use client';

import { useRouter } from 'next/navigation';
import { WarningCircle } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

export function AdminLoadFailure({
  correlationId,
  message = 'Данные временно недоступны. Остальные разделы продолжают работать.',
}: {
  correlationId: string;
  message?: string;
}) {
  const router = useRouter();
  return (
    <div
      role="alert"
      className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4"
    >
      <div className="flex items-start gap-3">
        <WarningCircle className="mt-0.5 size-5 shrink-0 text-[var(--color-danger)]" />
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-semibold">Ошибка загрузки</p>
          <p className="text-sm text-[var(--color-text-muted)]">{message}</p>
          <p className="break-all font-mono text-xs text-[var(--color-text-subtle)]">
            Код обращения: {correlationId}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
            Повторить
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AdminEmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed p-6 text-center text-sm text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}
