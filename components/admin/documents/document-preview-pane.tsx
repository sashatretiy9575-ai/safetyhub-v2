'use client';

import { useRef, useState } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react';
import { DocumentPdfPreview } from '@/components/admin/document-pdf-preview';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { PreviewJob } from '@/lib/pdf/document-preview-job';
import { cn } from '@/lib/utils';
import { useDocumentPreview, type DocumentPreviewTab } from './use-document-preview';

/**
 * The document the course would print, «Протокол» or «Корочка». On a phone the
 * booklet shows one half at a time, switched by a swipe or the two buttons.
 */
export function DocumentPreviewPane({
  tab,
  onTab,
  job,
  className,
}: {
  tab: DocumentPreviewTab;
  onTab(tab: DocumentPreviewTab): void;
  job: PreviewJob;
  className?: string;
}) {
  const preview = useDocumentPreview(job);
  const [half, setHalf] = useState<'left' | 'right'>('left');
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  return (
    <section
      data-document-preview
      aria-label="Предпросмотр документа"
      className={cn('min-w-0 space-y-2', className)}
    >
      <SegmentedControl
        label="Документ"
        value={tab}
        onChange={onTab}
        options={[
          { value: 'protocol', label: 'Протокол' },
          { value: 'certificate', label: 'Корочка' },
        ]}
      />
      {tab === 'certificate' ? (
        <SegmentedControl
          label="Половина разворота"
          className="lg:hidden"
          value={half}
          onChange={setHalf}
          options={[
            { value: 'left', label: 'Левая половина' },
            { value: 'right', label: 'Правая половина' },
          ]}
        />
      ) : null}
      <div
        className="relative min-h-24 rounded-[var(--radius-group)] bg-[var(--color-surface-soft)] p-2 sm:p-3 lg:max-h-[calc(100dvh-11rem)] lg:overflow-y-auto"
        onTouchStart={(event) => {
          const touch = event.touches[0];
          swipeStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
        }}
        onTouchEnd={(event) => {
          const from = swipeStart.current;
          const to = event.changedTouches[0];
          swipeStart.current = null;
          if (tab !== 'certificate' || !from || !to) return;
          const dx = to.clientX - from.x;
          const dy = to.clientY - from.y;
          // Scrolling the page with a thumb drifts sideways; a swipe is mostly horizontal.
          if (Math.abs(dx) > 48 && Math.abs(dx) > 2 * Math.abs(dy))
            setHalf(dx < 0 ? 'right' : 'left');
        }}
      >
        <div className="overflow-hidden">
          <div
            className={
              tab === 'certificate'
                ? cn('document-insert', half === 'right' && 'document-insert-right')
                : undefined
            }
          >
            <DocumentPdfPreview bytes={preview.bytes} pending={preview.pending} />
          </div>
        </div>
        {preview.working ? (
          <span
            role="status"
            aria-label="Обновляем документ"
            className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-[var(--color-surface)] shadow-[var(--shadow-soft)]"
          >
            <span className="size-4 animate-spin rounded-full border-2 border-[var(--color-primary)] border-r-transparent motion-reduce:animate-none" />
          </span>
        ) : null}
        {preview.message ? (
          <div className="flex flex-wrap items-center gap-2 p-2 text-sm">
            <p role="status" className="min-w-0 flex-1">
              {preview.message}
            </p>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Повторить предпросмотр"
              title="Повторить"
              onClick={preview.retry}
            >
              <ArrowsClockwise aria-hidden="true" />
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
