import type { ReactNode } from 'react';
import { Carousel } from '@/components/ui/carousel';

type MarketingSliderProps = {
  label: string;
  children: ReactNode;
  className?: string;
  itemClassName?: string;
  itemLabel?: string;
  /** `stack`: a plain grid on phones instead of a slider; three cards fit under each other. */
  mobile?: 'slider' | 'stack';
};

export function MarketingSlider({
  label,
  children,
  className,
  itemClassName,
  itemLabel,
  mobile = 'slider',
}: MarketingSliderProps) {
  return (
    <Carousel
      label={label}
      itemLabel={itemLabel}
      itemClassName={itemClassName}
      className={className}
      variant="marketing"
      mobile={mobile}
    >
      {children}
    </Carousel>
  );
}
