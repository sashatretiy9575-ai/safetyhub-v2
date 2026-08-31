import * as React from 'react';
import { cn } from '@/lib/utils';

type ContainerProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: 'narrow' | 'content' | 'wide' | 'admin';
  as?: 'div' | 'section' | 'article' | 'header' | 'footer' | 'main';
};

const sizeClass: Record<NonNullable<ContainerProps['size']>, string> = {
  narrow: 'max-w-[760px]',
  content: 'max-w-[1120px]',
  wide: 'max-w-[1280px]',
  admin: 'max-w-[1800px]',
};

export function Container({
  className,
  size = 'wide',
  as: Tag = 'div',
  ...props
}: ContainerProps) {
  return (
    <Tag
      className={cn(
        'mx-auto w-full pr-[max(1rem,var(--safe-area-right))] pl-[max(1rem,var(--safe-area-left))] md:pr-[max(1.5rem,var(--safe-area-right))] md:pl-[max(1.5rem,var(--safe-area-left))] xl:pr-[max(2rem,var(--safe-area-right))] xl:pl-[max(2rem,var(--safe-area-left))]',
        sizeClass[size],
        className,
      )}
      {...props}
    />
  );
}
