'use client';

import { Check, Eye, Pencil, UploadSimple } from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function EditorActionBar({
  busy,
  preview,
  statusLabel,
  published,
  hasDraftChanges = false,
  progress,
  liveMessage,
  onTogglePreview,
  onSave,
  onPublish,
}: {
  busy: boolean;
  preview: boolean;
  statusLabel: string;
  published: boolean;
  hasDraftChanges?: boolean;
  progress?: string;
  liveMessage: string;
  onTogglePreview: () => void;
  onSave: () => void;
  onPublish: () => void;
}) {
  return (
    <div
      data-editor-action-bar
      className="sticky top-[calc(3.5rem+var(--safe-area-top))] z-30 max-h-16 border-y border-[var(--color-border-strong)] bg-[var(--color-surface)]/96 px-3 py-2 shadow-[var(--shadow-card)] backdrop-blur-xl md:top-4 md:rounded-[var(--radius-lg)] md:border-x"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {progress ? <Badge variant="default">{progress}</Badge> : null}
        <Badge
          variant={published ? 'success' : 'default'}
          className="min-w-0 truncate max-[279px]:hidden"
        >
          {statusLabel}
        </Badge>
        {hasDraftChanges ? (
          <Badge variant="default" className="hidden lg:inline-flex">
            Есть черновик
          </Badge>
        ) : null}

        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="min-h-11 min-w-11 sm:w-auto sm:px-3"
            aria-label={preview ? 'Вернуться к форме' : 'Открыть предпросмотр'}
            title={preview ? 'Вернуться к форме' : 'Предпросмотр'}
            disabled={busy}
            onClick={onTogglePreview}
          >
            {preview ? <Pencil aria-hidden="true" /> : <Eye aria-hidden="true" />}
            <span className="hidden sm:inline">{preview ? 'Редактор' : 'Просмотр'}</span>
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="min-h-11 min-w-11 sm:w-auto sm:px-3"
            aria-label="Сохранить черновик"
            title="Сохранить"
            disabled={busy}
            onClick={onSave}
          >
            <Check aria-hidden="true" />
            <span className="hidden sm:inline">Сохранить</span>
          </Button>
          <Button
            type="button"
            size="icon"
            className="min-h-11 min-w-11 sm:w-auto sm:px-3"
            aria-label="Опубликовать"
            title="Опубликовать"
            disabled={busy}
            onClick={onPublish}
          >
            <UploadSimple aria-hidden="true" />
            <span className="hidden sm:inline">Опубликовать</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
