'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { DownloadSimple, SpinnerGap } from '@phosphor-icons/react';
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const download = async () => {
    if (busy) {
      abortRef.current?.abort();
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/certificates/${certificateId}/metadata`,
        { headers: { Accept: 'application/json' } },
        { timeoutMs: 30_000, signal: controller.signal },
      );
      if (!result.ok) {
        setMessage(localizedClientRequestMessage(result.error, t('downloadFailed'), errorT));
        return;
      }
      const metadata = await readClientResponseJson<CertificateRenderMetadata>(result.response);
      assertCertificateRenderMetadata(metadata);
      const { downloadCertificateInBrowser } = await import('@/lib/pdf/certificate-client');
      await downloadCertificateInBrowser(metadata, { signal: controller.signal });
      setMessage(t('generated'));
    } catch (error) {
      if (controller.signal.aborted) setMessage(t('cancelled'));
      else setMessage(localizedClientRequestMessage(error, t('downloadFailed'), errorT));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        onClick={() => void download()}
      >
        {busy ? <SpinnerGap className="animate-spin" /> : <DownloadSimple />}
        {busy ? t('cancel') : (children ?? t('downloadPdf'))}
      </Button>
      {message ? (
        <span
          role={message === t('generated') ? 'status' : 'alert'}
          className={
            message === t('generated')
              ? 'sr-only'
              : 'text-xs text-[var(--color-danger)]'
          }
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}
