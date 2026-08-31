'use client';

import { Container } from '@/components/ui/container';
import { AppErrorState } from '@/components/shared/app-state';
import { reportAppError } from '@/lib/observability';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const diagnostic = reportAppError(error, { source: 'route-error' });

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <AppErrorState
        title="Что-то пошло не так"
        description="Данные не загрузились полностью. Можно повторить попытку или вернуться на главную."
        error={error}
        diagnostic={diagnostic}
        onRetry={reset}
        retryLabel="Попробовать снова"
      />
    </Container>
  );
}
