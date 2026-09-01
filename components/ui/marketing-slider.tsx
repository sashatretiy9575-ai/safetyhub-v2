import type { ReactNode } from 'react';
import { Carousel } from '@/components/ui/carousel';

type MarketingSliderProps = {
  label: string;
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  itemLabel?: string;
};

export function MarketingSlider({
  label,
  children,
  className,
  itemClassName,
  itemLabel,
}: MarketingSliderProps) {
  return (
    <Carousel
      label={label}
      itemLabel={itemLabel}
      itemClassName={itemClassName}
      className={className}
      variant="marketing"
    >
      {children}
    </Carousel>
  );
}
