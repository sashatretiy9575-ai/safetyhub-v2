'use client';

import { Container } from '@/components/ui/container';
import { useTranslations } from 'next-intl';
import { AppErrorState } from '@/components/shared/app-state';
import { reportAppError } from '@/lib/observability';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  const t = useTranslations('AppState');
  const common = useTranslations('Common');
  const diagnostic = reportAppError(error, { source: 'route-error' });

  return (
    <Container size="narrow" className="grid min-h-[60vh] place-items-center py-16 text-center">
      <AppErrorState
        title={t('errorTitle')}
        description={t('errorDescription')}
        error={error}
        diagnostic={diagnostic}
        onRetry={reset}
        retryLabel={common('retry')}
        correlationLabel={common('correlationIdPlain')}
      />
    </Container>
  );
}
