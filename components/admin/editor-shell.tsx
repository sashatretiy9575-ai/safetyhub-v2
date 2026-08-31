import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EditorShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-editor-shell className={cn('max-w-full min-w-0 space-y-6 md:space-y-8', className)}>
      {children}
    </div>
  );
}
