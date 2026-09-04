'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ImageSquare, Trash, UploadSimple, X } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { clientRequest, readClientResponseJson } from '@/lib/client-request';
import { formatContentImagePreparation, prepareContentImage } from '@/lib/content-image';

type Asset = {
  id: string;
  url: string;
  width: number;
  height: number;
  bytes: number;
  filename: string;
  status: 'active' | 'orphan_candidate' | 'delete_pending';
  usageCount: number;
};

export function MediaAssetInput({
  id,
  value,
  onChange,
  placeholder = '/images/generated/photo.webp',
  ariaLabel,
  maxWidth = 1600,
  maxHeight = 1600,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  maxWidth?: number;
  maxHeight?: number;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preparation, setPreparation] = useState('');
  // A path can be typed by hand or point at a file that was later removed from
  // the library, so the preview has to survive a failed load instead of leaving
  // an unexplained empty box.
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    setPreviewFailed(false);
  }, [value]);

  const load = async () => {
    const result = await clientRequest('/api/admin/content-assets');
    const payload = await readClientResponseJson<{ items?: Asset[] }>(result.response);
    if (!result.ok || !payload?.items) throw new Error('MEDIA_LIBRARY_UNAVAILABLE');
    setAssets(payload.items.filter((asset) => asset.status === 'active'));
  };

  useEffect(() => {
    if (!open) return;
    void load().catch(() => setError('Не удалось загрузить медиатеку.'));
  }, [open]);

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    setPreparation('Декодируем и оптимизируем изображение…');
    try {
      const prepared = await prepareContentImage(file, { maxWidth, maxHeight });
      setPreparation(formatContentImagePreparation(prepared));
      const form = new FormData();
      form.set('asset', prepared.file);
      const result = await clientRequest('/api/admin/content-assets', {
        method: 'POST',
        body: form,
      });
      const payload = await readClientResponseJson<{
        url?: string;
        error?: string;
      }>(result.response);
      if (!result.ok || !payload?.url) throw new Error(payload?.error ?? 'UPLOAD_FAILED');
      onChange(payload.url);
      await load();
    } catch {
      setError('Не удалось загрузить изображение. Используйте JPEG, PNG, WebP или AVIF до 8 МБ.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = async (asset: Asset) => {
    if (asset.usageCount !== 0 || value === asset.url) return;
    if (!window.confirm('Удалить неиспользуемое изображение из медиатеки?')) return;
    setBusy(true);
    setError('');
    try {
      const result = await clientRequest(`/api/admin/content-assets/${asset.id}`, {
        method: 'DELETE',
      });
      if (!result.ok) throw new Error('ASSET_DELETE_FAILED');
      await load();
    } catch {
      setError('Изображение используется или не прошло повторную проверку ссылок.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
        <Input
          id={id}
          aria-label={ariaLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="min-w-0 flex-1"
        />
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          onClick={() => setOpen((current) => !current)}
        >
          {open ? <X /> : <ImageSquare />} {open ? 'Закрыть' : 'Медиатека'}
        </Button>
      </div>

      {value ? (
        <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-2">
          <span className="relative block aspect-video w-32 shrink-0 overflow-hidden rounded-lg bg-[var(--color-surface)]">
            {previewFailed ? (
              <span className="grid size-full place-items-center px-1 text-center text-[10px] leading-tight text-[var(--color-text-muted)]">
                Файл не открылся
              </span>
            ) : (
              <Image
                src={value}
                alt="Выбранное изображение"
                fill
                sizes="128px"
                className="object-cover"
                onError={() => setPreviewFailed(true)}
              />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-xs font-bold" title={value}>
              {value.split('/').pop() || value}
            </p>
            {previewFailed ? (
              <p role="alert" className="text-xs text-[var(--color-danger)]">
                По этому пути изображение не загружается. Выберите файл из медиатеки.
              </p>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                Так изображение выглядит на сайте.
              </p>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
                Заменить
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onChange('')}>
                Очистить
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {open ? (
        <div className="space-y-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-muted)] p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-bold">Изображения CMS</p>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <UploadSimple /> {busy ? 'Обработка…' : 'Загрузить'}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/avif"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
          </div>
          {error ? (
            <p role="alert" className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          ) : null}
          {preparation ? (
            <p role="status" className="text-xs text-[var(--color-text-muted)]">
              {preparation}
            </p>
          ) : null}
          {assets.length ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className={`min-w-0 space-y-1 rounded-lg border bg-[var(--color-surface)] p-2 ${
                    asset.url === value
                      ? 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]'
                      : ''
                  }`}
                >
                  <button
                    type="button"
                    className="block w-full min-w-0 text-left focus-visible:outline-[3px] focus-visible:outline-[var(--color-focus)]"
                    onClick={() => {
                      onChange(asset.url);
                      setOpen(false);
                    }}
                  >
                    <span className="relative block aspect-video overflow-hidden rounded-md bg-[var(--color-surface-muted)]">
                      <Image
                        src={asset.url}
                        alt=""
                        fill
                        sizes="(max-width: 640px) 50vw, 220px"
                        className="object-cover"
                      />
                    </span>
                    <span className="mt-1 block truncate text-xs" title={asset.filename}>
                      {asset.filename}
                    </span>
                    <span className="block text-[10px] text-[var(--color-text-muted)]">
                      {asset.width}×{asset.height} · {Math.ceil(asset.bytes / 1024)} КБ · ссылок{' '}
                      {asset.usageCount}
                    </span>
                  </button>
                  {asset.usageCount === 0 && value !== asset.url ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="w-full"
                      disabled={busy}
                      onClick={() => remove(asset)}
                    >
                      <Trash /> Удалить сироту
                    </Button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">Медиатека пока пуста.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
