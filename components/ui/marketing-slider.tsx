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
  itemLabel = 'Карточка',
}: MarketingSliderProps) {
  return (
    <Carousel
      label={label}
      itemLabel={itemLabel}
      itemClassName={itemClassName}
      className={className}
      variant="marketing"
      previousLabel={`Предыдущая ${itemLabel.toLocaleLowerCase('ru-RU')}`}
      nextLabel={`Следующая ${itemLabel.toLocaleLowerCase('ru-RU')}`}
    >
      {children}
    </Carousel>
  );
}
