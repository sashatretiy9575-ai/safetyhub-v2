'use client';

import { useState } from 'react';
import { DownloadSimple, SpinnerGap } from '@phosphor-icons/react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { clientRequest, clientRequestMessage } from '@/lib/client-request';

function responseFilename(disposition: string | null, fallback: string) {
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      // Continue with the ASCII fallback from the same header.
    }
  }
  return disposition.match(/filename="?([^";]+)"?/iu)?.[1] ?? fallback;
}

async function isPdf(blob: Blob) {
  if (blob.size < 5) return false;
  const signature = new Uint8Array(await blob.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...signature) === '%PDF-';
}

export function CertificateDownloadButton({
  certificateId,
  children = 'Скачать PDF',
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
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await clientRequest(
        `/api/certificates/${certificateId}`,
        { headers: { Accept: 'application/pdf' } },
        { timeoutMs: 60_000 },
      );
      if (!result.ok) {
        setMessage(clientRequestMessage(result.error, 'PDF не удалось скачать.'));
        return;
      }
      const blob = await result.response.blob();
      if (!result.response.headers.get('content-type')?.startsWith('application/pdf') || !(await isPdf(blob))) {
        setMessage('Сервер вернул повреждённый PDF. Повторите попытку.');
        return;
      }

      const filename = responseFilename(
        result.response.headers.get('content-disposition'),
        `safetyhub-certificate-${certificateId}.pdf`,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.rel = 'noopener';
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage('PDF передан браузеру для скачивания.');
    } catch (error) {
      setMessage(clientRequestMessage(error, 'PDF не удалось скачать.'));
    } finally {
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
        disabled={busy}
        onClick={() => void download()}
      >
        {busy ? <SpinnerGap className="animate-spin" /> : <DownloadSimple />}
        {busy ? 'Готовим PDF…' : children}
      </Button>
      {message ? (
        <span
          role={message.startsWith('PDF передан') ? 'status' : 'alert'}
          className={message.startsWith('PDF передан') ? 'sr-only' : 'text-xs text-[var(--color-danger)]'}
        >
          {message}
        </span>
      ) : null}
    </span>
  );
}
