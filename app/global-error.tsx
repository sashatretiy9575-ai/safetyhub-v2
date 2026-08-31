'use client';

import { AppErrorState } from '@/components/shared/app-state';
import { reportAppError } from '@/lib/observability';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const diagnostic = reportAppError(error, { source: 'global-error', digest: error.digest });

  return (
    <html lang="ru">
      <body className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-bg)] p-6 text-[var(--color-text)]">
        <div className="w-full max-w-2xl">
          <AppErrorState
            title="Произошла критическая ошибка"
            description="Приложение не удалось открыть полностью. Обновите страницу или вернитесь на главную."
            error={error}
            diagnostic={diagnostic}
            onRetry={reset}
            retryLabel="Повторить попытку"
            compact
          />
          {error.digest ? (
            <p className="mt-4 text-center font-mono text-xs text-[var(--color-text-subtle)]">
              ID ошибки: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
