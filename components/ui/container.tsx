import * as React from 'react';
import { cn } from '@/lib/utils';
import { CONTAINER_BASE, CONTAINER_SIZES } from '@/components/ui/container-classes';

type ContainerProps = React.HTMLAttributes<HTMLDivElement> & {
  size?: keyof typeof CONTAINER_SIZES;
  as?: 'div' | 'section' | 'article' | 'header' | 'footer' | 'main';
};

export function Container({
  className,
  size = 'wide',
  as: Tag = 'div',
  ...props
}: ContainerProps) {
  return <Tag className={cn(CONTAINER_BASE, CONTAINER_SIZES[size], className)} {...props} />;
}
