import { Container } from './container';
import { cn } from '@/lib/utils';

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  className?: string;
  variant?: 'default' | 'compact' | 'contact';
};

export function PageHeader({
  eyebrow,
  title,
  description,
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
          <p className="text-xs font-bold tracking-widest text-[var(--color-text-subtle)] uppercase">
            {eyebrow}
          </p>
        )}
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl space-y-3">
            <h1 className="text-display font-bold text-balance">{title}</h1>
            {description && (
              <p className="text-lead max-w-2xl text-pretty text-[var(--color-text-muted)]">
                {description}
              </p>
            )}
          </div>
        </div>
      </Container>
    </header>
  );
}
