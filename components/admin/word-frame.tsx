import { fieldFrameFocus } from '@/components/ui/field';
import { cn } from '@/lib/utils';

/**
 * One frame around bare inputs and the words that name them: «с … по …»,
 * «40 ч», «протокол от 22.09.2026». A date or a number draws its own digits,
 * so a placeholder cannot name it; the word inside the frame does.
 */
export function WordFrame({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex min-h-11 min-w-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 shadow-[var(--shadow-soft)]',
        fieldFrameFocus,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function FrameWord({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden className="text-caption text-[var(--color-text-subtle)]">
      {children}
    </span>
  );
}

/** The input inside a frame: the frame draws the border and the focus. */
export const FRAME_INPUT = 'min-w-0 flex-1 bg-transparent text-sm text-[var(--color-text)] outline-none';
