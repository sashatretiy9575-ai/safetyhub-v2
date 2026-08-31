import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import { cn } from '@/lib/utils';

type SectionShellProps = ComponentPropsWithoutRef<'section'> & {
  id?: string;
  className?: string;
  innerClassName?: string;
  children: ReactNode;
};

export function SectionShell({
  id,
  className,
  innerClassName,
  children,
  ...props
}: SectionShellProps) {
  return (
    <section id={id} className={className} {...props}>
      <div className={cn('mx-auto w-full max-w-[1280px] px-4 md:px-6 xl:px-8', innerClassName)}>{children}</div>
    </section>
  );
}
