'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, DownloadSimple, SpinnerGap } from '@phosphor-icons/react';
import { Button, type ButtonProps } from '@/components/ui/button';
import {
  clientRequest,
  readClientResponseJson,
} from '@/lib/client-request';
import {
  assertCertificateRenderMetadata,
  type CertificateRenderMetadata,
} from '@/lib/pdf/certificate-client-contract';
import { localizedClientRequestMessage } from '@/i18n/client-errors';

export function CertificateDownloadButton({
  certificateId,
  children,
  variant = 'primary',
  size = 'sm',
  className,
}: {
  certificateId: string;
  children?: React.ReactNode;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  className?: string;
}) {
  const t = useTranslations('Certificate');
  const errorT = useTranslations('Common.errors');
  const [status, setStatus] = useState<'idle' | 'busy' | 'downloaded'>('idle');
  const [message, setMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const download = async () => {
    if (status === 'busy') {
      abortRef.current?.abort();
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('busy');
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/certificates/${certificateId}/metadata`,
        { headers: { Accept: 'application/json' } },
        { timeoutMs: 30_000, signal: controller.signal },
      );
      if (!result.ok) {
        setMessage(localizedClientRequestMessage(result.error, t('downloadFailed'), errorT));
        setStatus('idle');
        return;
      }
      const metadata = await readClientResponseJson<CertificateRenderMetadata>(result.response);
      assertCertificateRenderMetadata(metadata);
      const { downloadCertificateInBrowser } = await import('@/lib/pdf/certificate-client');
      await downloadCertificateInBrowser(metadata, { signal: controller.signal });
      setStatus('downloaded');
      setTimeout(() => setStatus('idle'), 4000);
    } catch (error) {
      if (controller.signal.aborted) {
        setMessage(t('cancelled'));
      } else {
        console.error('[CertificateDownload]', error);
        setMessage(t('downloadFailed'));
      }
      setStatus('idle');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <Button
        type="button"
        variant={status === 'downloaded' ? 'outline' : variant}
        size={size}
        className={className}
        onClick={() => void download()}
        disabled={status === 'busy'}
      >
        {status === 'busy' ? (
          <SpinnerGap className="animate-spin" />
        ) : status === 'downloaded' ? (
          <Check weight="bold" className="text-[var(--color-primary)]" />
        ) : (
          <DownloadSimple />
        )}
        {status === 'busy'
          ? t('generating')
          : status === 'downloaded'
            ? t('downloaded')
            : (children ?? t('downloadPdf'))}
      </Button>
      {message ? (
        <span role="alert" className="text-xs text-[var(--color-danger)]">
          {message}
        </span>
      ) : null}
    </span>
  );
}
