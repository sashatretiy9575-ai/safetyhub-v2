'use client';

import { FilePdf, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { useRef, useState } from 'react';
import type { AdminPresentation } from '@/features/admin/types';
import { Button } from '@/components/ui/button';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { TEST_EDITOR_LIMITS } from '@/lib/admin-test-editor';
import type { AppLocale } from '@/lib/supabase/types';

type UploadGrant = {
  presentationId: string;
  endpoint: string;
  bucket: string;
  pdf: { path: string; token: string };
  thumbnail: { path: string; token: string };
};

type PendingFinalize = {
  presentationId: string;
  locale: AppLocale;
  sha256: string;
  pageCount: number;
};

class PresentationFinalizeError extends Error {
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.name = 'PresentationFinalizeError';
    this.retryable = retryable;
  }
}

function presentationUploadErrorMessage(code: string) {
  switch (code) {
    case 'PRESENTATION_FILE_TOO_LARGE':
      return 'PDF должен быть не больше 25 МБ.';
    case 'PRESENTATION_INVALID_PDF':
      return 'Не удалось прочитать PDF. Проверьте файл и отсутствие пароля.';
    case 'PRESENTATION_ENCRYPTED':
      return 'PDF защищён паролем. Загрузите незашифрованную версию.';
    case 'PRESENTATION_UNSAFE_ACTION':
      return 'PDF содержит запрещённые действия, сценарии или вложенные файлы.';
    case 'COURSE_CATALOG_MAINTENANCE':
      return 'Каталог находится в режиме обслуживания. Загрузка будет доступна после его отключения.';
    case 'CATALOG_MAINTENANCE_REQUIRED':
      return 'Сначала включите режим обслуживания каталога.';
    case 'UPLOAD_ABORTED':
      return 'Загрузка отменена. Временный файл поставлен на очистку.';
    default:
      return 'Не удалось загрузить или проверить PDF. Повторите попытку.';
  }
}

function hex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('THUMBNAIL_FAILED'))),
      'image/webp',
      0.82,
    ),
  );
}

async function inspectPdf(file: File) {
  if (file.type !== 'application/pdf') throw new Error('PRESENTATION_INVALID_PDF');
  if (file.size <= 0 || file.size > TEST_EDITOR_LIMITS.presentationMaxBytes) {
    throw new Error('PRESENTATION_FILE_TOO_LARGE');
  }
  const source = await file.arrayBuffer();
  const header = new TextDecoder('latin1').decode(source.slice(0, 2048));
  if (!header.startsWith('%PDF-')) throw new Error('PRESENTATION_INVALID_PDF');
  const [sha256, pdfjs] = await Promise.all([
    crypto.subtle.digest('SHA-256', source),
    import('pdfjs-dist'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdfjs.getDocument({ data: source.slice(0), enableXfa: false });
  const document = await task.promise;
  try {
    if (document.numPages < 1 || document.numPages > TEST_EDITOR_LIMITS.presentationMaxPages) {
      throw new Error('PRESENTATION_INVALID_PDF');
    }
    const page = await document.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(1, 640 / base.width) });
    const canvas = window.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return {
      sha256: hex(sha256),
      pageCount: document.numPages,
      thumbnail: await canvasBlob(canvas),
    };
  } finally {
    await task.destroy();
  }
}

async function tusUpload(
  file: Blob,
  grant: UploadGrant,
  target: 'pdf' | 'thumbnail',
  contentType: string,
  onProgress: (progress: number) => void,
  rememberCancel: (cancel: (() => void) | null) => void,
) {
  const tus = await import('tus-js-client');
  const destination = grant[target];
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let cancelled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const upload = new tus.Upload(file, {
      endpoint: grant.endpoint,
      retryDelays: [0, 1_000, 3_000, 5_000, 10_000],
      headers: { 'x-signature': destination.token },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: {
        bucketName: grant.bucket,
        bucketId: grant.bucket,
        objectName: destination.path,
        contentType,
        cacheControl: '3600',
      },
      onError: (error) => settle(() => reject(error)),
      onProgress: (uploaded, total) => onProgress(total > 0 ? uploaded / total : 0),
      onSuccess: () => settle(resolve),
    });
    rememberCancel(() => {
      cancelled = true;
      void upload.abort(true).catch(() => undefined);
      settle(() => reject(new DOMException('UPLOAD_ABORTED', 'AbortError')));
    });
    void upload
      .findPreviousUploads()
      .then((previous) => {
        if (cancelled) return;
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch((error) => settle(() => reject(error)));
  }).finally(() => rememberCancel(null));
}

function adminPresentationUrl(
  courseId: string,
  presentationId: string,
  asset: 'presentation' | 'thumbnail',
  download = false,
) {
  const query = new URLSearchParams({ asset });
  if (download) query.set('download', '1');
  return `/api/admin/courses/${encodeURIComponent(courseId)}/presentation/${encodeURIComponent(presentationId)}?${query.toString()}`;
}

export function CoursePresentationInput({
  courseId,
  locale = 'ru',
  value,
  onChange,
}: {
  courseId: string | null;
  locale?: AppLocale;
  value: AdminPresentation | null;
  onChange: (value: AdminPresentation | null) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const cancelUploadRef = useRef<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [pendingFinalize, setPendingFinalize] = useState<PendingFinalize | null>(null);

  const finalizePresentation = async (pending: PendingFinalize) => {
    if (!courseId) throw new PresentationFinalizeError('PRESENTATION_NOT_READY', false);
    const finalizeResult = await clientRequest(
      `/api/admin/courses/${courseId}/presentation/finalize`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending),
      },
    );
    const presentation = await readClientResponseJson<AdminPresentation & { error?: string }>(
      finalizeResult.response,
    );
    if (!finalizeResult.ok || !presentation?.id) {
      const code = presentation?.error ?? 'PRESENTATION_VALIDATION_FAILED';
      const retryable =
        !finalizeResult.response ||
        (!finalizeResult.ok && finalizeResult.error.retryable) ||
        code === 'COURSE_CATALOG_MAINTENANCE' ||
        code === 'CATALOG_MAINTENANCE_REQUIRED';
      throw new PresentationFinalizeError(code, retryable);
    }
    return presentation;
  };

  const retryFinalize = async () => {
    if (!pendingFinalize) return;
    setBusy(true);
    setError('');
    setStatus('Сервер повторно проверяет загруженный файл…');
    try {
      const presentation = await finalizePresentation(pendingFinalize);
      setPendingFinalize(null);
      onChange(presentation);
      setProgress(100);
      setStatus('PDF проверен и готов к публикации.');
    } catch (finalizeError) {
      if (finalizeError instanceof PresentationFinalizeError && !finalizeError.retryable) {
        setPendingFinalize(null);
      }
      const code = finalizeError instanceof Error ? finalizeError.message : '';
      setError(presentationUploadErrorMessage(code));
      setStatus('');
    } finally {
      setBusy(false);
    }
  };

  const uploadFile = async (file: File) => {
    if (!courseId) {
      setError('Сначала сохраните черновик курса.');
      return;
    }
    setBusy(true);
    setError('');
    setProgress(0);
    let stagedPresentationId: string | null = null;
    let finalizeStarted = false;
    try {
      setStatus('Проверяем PDF и создаём миниатюру…');
      const inspected = await inspectPdf(file);
      const grantResult = await clientRequest(
        `/api/admin/courses/${courseId}/presentation/upload-token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            locale,
            filename: file.name,
            mimeType: file.type,
            byteSize: file.size,
            sha256: inspected.sha256,
            pageCount: inspected.pageCount,
          }),
        },
      );
      const grant = await readClientResponseJson<UploadGrant & { error?: string }>(
        grantResult.response,
      );
      if (!grantResult.ok || !grant?.presentationId)
        throw new Error(grant?.error ?? 'PRESENTATION_UPLOAD_TOKEN_FAILED');
      stagedPresentationId = grant.presentationId;
      setStatus('Загружаем презентацию…');
      await tusUpload(
        file,
        grant,
        'pdf',
        'application/pdf',
        (value) => setProgress(value * 95),
        (cancel) => {
          cancelUploadRef.current = cancel;
        },
      );
      setStatus('Загружаем миниатюру…');
      await tusUpload(
        inspected.thumbnail,
        grant,
        'thumbnail',
        'image/webp',
        (value) => setProgress(95 + value * 5),
        (cancel) => {
          cancelUploadRef.current = cancel;
        },
      );
      setStatus('Сервер проверяет файл…');
      finalizeStarted = true;
      const finalizeRequest = {
        presentationId: grant.presentationId,
        locale,
        sha256: inspected.sha256,
        pageCount: inspected.pageCount,
      };
      setPendingFinalize(finalizeRequest);
      const presentation = await finalizePresentation(finalizeRequest);
      setPendingFinalize(null);
      onChange(presentation);
      setProgress(100);
      setStatus('PDF проверен и готов к публикации.');
    } catch (uploadError) {
      const code = uploadError instanceof Error ? uploadError.message : '';
      if (stagedPresentationId && !finalizeStarted) {
        await clientRequest(`/api/admin/courses/${courseId}/presentation/${stagedPresentationId}`, {
          method: 'DELETE',
        }).catch(() => undefined);
      }
      if (uploadError instanceof PresentationFinalizeError && !uploadError.retryable) {
        setPendingFinalize(null);
      }
      setError(presentationUploadErrorMessage(code));
      setStatus('');
    } finally {
      cancelUploadRef.current = null;
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!value || !window.confirm('Удалить эту неиспользуемую версию презентации?')) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest(
        `/api/admin/courses/${courseId ?? 'new'}/presentation/${value.id}`,
        { method: 'DELETE' },
      );
      if (!result.ok) throw new Error('PRESENTATION_IN_USE');
      onChange(null);
      setStatus('Презентация удалена.');
    } catch {
      setError(
        'Эта презентация используется черновиком или опубликованной редакцией и не может быть удалена.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {!courseId ? (
        <p className="rounded-xl bg-[var(--color-primary-soft)] p-3 text-sm font-semibold">
          Сначала сохраните черновик курса, затем загрузите PDF.
        </p>
      ) : null}
      {value ? (
        <div className="flex flex-col gap-4 rounded-xl border border-[var(--color-border)] p-4 sm:flex-row sm:items-center">
          {courseId ? (
            // The same-origin route checks the administrator capability and
            // streams the private bytes with no-store. Immutable Storage paths
            // never enter this browser bundle as public or signed URLs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={adminPresentationUrl(courseId, value.id, 'thumbnail')}
              alt="Первая страница презентации"
              width={320}
              height={180}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              className="aspect-video w-full rounded-lg bg-slate-100 object-cover sm:w-48"
            />
          ) : (
            <FilePdf size={48} aria-hidden="true" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-bold">PDF готов</p>
            <p className="text-sm text-[var(--color-text-muted)]">
              {value.pageCount} страниц · {(value.byteSize / 1024 / 1024).toFixed(1)} МБ
            </p>
            <p className="truncate text-xs text-[var(--color-text-subtle)]" title={value.sha256}>
              SHA-256: {value.sha256}
            </p>
            {courseId ? (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                <a
                  href={adminPresentationUrl(courseId, value.id, 'presentation')}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--color-primary)] underline"
                >
                  Открыть PDF
                </a>
                <a
                  href={adminPresentationUrl(courseId, value.id, 'presentation', true)}
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--color-primary)] underline"
                >
                  Скачать PDF
                </a>
              </div>
            ) : null}
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={busy}
            aria-label="Удалить версию презентации"
            onClick={() => void remove()}
          >
            <Trash aria-hidden="true" />
          </Button>
        </div>
      ) : (
        <p className="text-sm text-[var(--color-text-muted)]">
          Загрузите PDF. Исходный PPTX пользователям не выдаётся.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant={value ? 'outline' : 'primary'}
          disabled={busy || !courseId || Boolean(pendingFinalize)}
          onClick={() => fileRef.current?.click()}
        >
          <UploadSimple aria-hidden="true" />
          {value ? 'Заменить PDF' : 'Загрузить PDF'}
        </Button>
        {pendingFinalize && !busy ? (
          <Button type="button" variant="outline" onClick={() => void retryFinalize()}>
            Повторить серверную проверку
          </Button>
        ) : null}
        {busy ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              cancelUploadRef.current?.();
              setStatus('Загрузка отменяется…');
            }}
          >
            <X aria-hidden="true" />
            Отменить
          </Button>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadFile(file);
          }}
        />
      </div>
      {busy ? (
        <progress
          className="h-2 w-full accent-[var(--color-primary)]"
          max={100}
          value={progress}
          aria-label={`Загрузка презентации: ${Math.round(progress)}%`}
        />
      ) : null}
      {status ? (
        <p role="status" className="text-sm text-[var(--color-text-muted)]">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-[var(--color-danger)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
