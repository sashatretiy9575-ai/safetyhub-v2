import { Container } from './container';
import { cn } from '@/lib/utils';

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  className?: string;
  variant?: 'default' | 'compact' | 'contact';
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
  variant = 'default',
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        'border-b border-[var(--color-border)]',
        variant === 'contact'
          ? 'py-5 sm:py-7 lg:py-10'
          : variant === 'compact'
            ? 'py-7 sm:py-9 md:py-12'
            : 'py-9 sm:py-12 md:py-16',
        className,
      )}
    >
      <Container size="wide" className="space-y-4">
        {eyebrow && (
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-[var(--color-text-subtle)]">
            {eyebrow}
          </p>
        )}
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            <h1 className="text-balance text-[28px] font-bold leading-[1.18] tracking-[-0.03em] sm:text-[36px] md:text-[44px] lg:text-[52px]">
              {title}
            </h1>
            {description && (
              <p className="max-w-2xl text-pretty text-[15px] leading-[1.55] text-[var(--color-text-muted)] sm:text-base md:text-lg">{description}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-3">{actions}</div>}
        </div>
      </Container>
    </header>
  );
}
