'use client';

import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { FACSIMILE_INPUT_TYPES } from '@/lib/pdf/facsimile-browser';
import { cn } from '@/lib/utils';

/**
 * What every tile of a stamp or a signature is made of: the sheet the picture
 * lies on, the way a file reaches it, and the words for a file that did not
 * fit. The tiles differ in what they do with the file, not in any of this.
 */

/** A refusal named by `prepareFacsimilePng` or by an upload route, in the administrator's words. */
export const FACSIMILE_FAILURES = {
  FACSIMILE_TYPE: 'Нужен файл PNG или JPG',
  FACSIMILE_TOO_LARGE: 'Файл больше 20 МБ',
  FACSIMILE_UNREADABLE: 'Файл не открывается как картинка',
  FACSIMILE_EMPTY: 'На картинке не видно чернил',
  CERTIFICATE_IMAGE_INVALID: 'Картинка не подошла, нужен PNG',
  RATE_LIMITED: 'Слишком часто, повторите через минуту',
} as const;

/** The words for a thrown refusal; whatever has no name gets the tile's own `fallback`. */
export function facsimileFailure(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : '';
  return Object.hasOwn(FACSIMILE_FAILURES, code)
    ? FACSIMILE_FAILURES[code as keyof typeof FACSIMILE_FAILURES]
    : fallback;
}

/**
 * One tile's way in for a file: a hidden input opened by `choose`, and a drop
 * on whatever element takes `drop`. A file that arrives while the tile is
 * `blocked` is let go of; it is still caught, so the browser does not open it
 * in place of the editor.
 */
export function useFacsimileSource(onFile: (file: File) => void, blocked = false) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return {
    /** A file is being held over the sheet. */
    over: over && !blocked,
    choose: () => input.current?.click(),
    input: {
      ref: input,
      type: 'file',
      accept: FACSIMILE_INPUT_TYPES,
      className: 'sr-only',
      tabIndex: -1,
      'aria-hidden': true,
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        // The same file picked again has to be a change again.
        event.target.value = '';
        if (file && !blocked) onFile(file);
      },
    },
    drop: {
      onDragOver: (event: DragEvent) => {
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        event.preventDefault();
        setOver(false);
        const file = event.dataTransfer.files?.[0];
        if (file && !blocked) onFile(file);
      },
    },
  } as const;
}

/** Ink is judged on paper, so the sheet is white in the dark theme too. */
export function facsimilePaper(present: boolean, over: boolean) {
  return cn(
    'relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-[var(--radius-md)] border bg-white text-neutral-500 transition disabled:cursor-not-allowed',
    present ? 'border-[var(--color-border)]' : 'border-dashed border-[var(--color-border-strong)]',
    over && 'border-[var(--color-primary)] ring-2 ring-[var(--color-primary)]',
  );
}

export function FacsimilePicture({
  src,
  alt = '',
  className = 'size-full object-contain p-2',
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  return (
    // A private image behind the session, addressed by its version or its id; next/image has nothing to optimise.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} className={className} draggable={false} />
  );
}

/** Covers the sheet while its picture is on the way to the server. */
export function FacsimileSpinner() {
  return (
    <span className="absolute inset-0 flex items-center justify-center bg-white/80">
      <span
        role="status"
        aria-label="Сохраняем"
        className="size-6 animate-spin rounded-full border-2 border-neutral-700 border-r-transparent motion-reduce:animate-none"
      />
    </span>
  );
}
