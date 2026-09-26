'use client';

import { useEffect, useRef, useState } from 'react';
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
import { cn } from '@/lib/utils';

/**
 * Deliberately twice the shared client default: this request resolves a
 * certificate and its assets, and a learner on a phone in a workshop should
 * not be told it failed because the network was slow.
 */
const CERTIFICATE_METADATA_TIMEOUT_MS = 30_000;

/** How long the button keeps saying the file was saved. */
const DOWNLOADED_STATE_RESET_MS = 4_000;

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
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    },
    [],
  );

  const download = async () => {
    if (status === 'busy') {
      abortRef.current?.abort();
      return;
    }
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus('busy');
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/certificates/${certificateId}/metadata`,
        { headers: { Accept: 'application/json' } },
        { timeoutMs: CERTIFICATE_METADATA_TIMEOUT_MS, signal: controller.signal },
      );
      if (!result.ok) {
        setMessage(localizedClientRequestMessage(result.error, t('downloadFailed'), errorT));
        setStatus('idle');
        return;
      }
      const metadata = await readClientResponseJson<CertificateRenderMetadata>(result.response);
      assertCertificateRenderMetadata(metadata);
      if (!metadata.branding.documentDefaults?.insertWidthCm || !metadata.branding.documentDefaults?.insertHeightCm) {
        setMessage(t('sizeRequired')); setStatus('idle'); return;
      }
      const { downloadCertificateInBrowser } = await import('@/lib/pdf/certificate-client');
      await downloadCertificateInBrowser(metadata, { signal: controller.signal });
      setStatus('downloaded');
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        setStatus('idle');
      }, DOWNLOADED_STATE_RESET_MS);
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

  const busy = status === 'busy';

  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      {/* Spoken progress and failure, from regions present before their text:
          one mounted together with its message is often not announced. The
          visible line under the button is for the eye. */}
      <span role="status" className="sr-only">
        {busy ? t('generating') : status === 'downloaded' ? t('downloaded') : ''}
      </span>
      <span role="alert" className="sr-only">
        {message}
      </span>
      {/* aria-disabled rather than disabled while the PDF is prepared: a
          disabled button drops keyboard focus to the page, and the learner
          had to find their place again. It looks and acts disabled all the
          same. */}
      <Button
        type="button"
        variant={status === 'downloaded' ? 'outline' : variant}
        size={size}
        className={cn(
          'aria-disabled:pointer-events-none aria-disabled:opacity-50',
          className,
        )}
        onClick={() => {
          if (!busy) void download();
        }}
        aria-disabled={busy || undefined}
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
        <span aria-hidden="true" className="text-xs text-[var(--color-danger)]">
          {message}
        </span>
      ) : null}
    </span>
  );
}
