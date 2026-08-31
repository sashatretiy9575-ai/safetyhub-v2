import { cn } from '@/lib/utils';
import { ShieldCheck } from '@phosphor-icons/react/dist/ssr';

type LogoProps = {
  className?: string;
  inverse?: boolean;
};

export function Logo({ className, inverse = false }: LogoProps) {
  return (
    <div className={cn('inline-flex items-center gap-2', className)}>
      <div
        data-logo-mark
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-[10px] border shadow-[var(--shadow-soft)] min-[1120px]:size-8 min-[1120px]:rounded-[var(--radius-control)]',
          inverse
            ? 'border-white/15 bg-white/[0.06] text-[#70c990] shadow-none'
            : 'border-[var(--color-border)] bg-[var(--color-surface-elevated)] text-[var(--color-primary)]',
        )}
      >
        <ShieldCheck size={19} weight="regular" className="min-[1120px]:size-5" />
      </div>
      <span
        data-logo-wordmark
        className={cn(
          'text-[17px] font-extrabold tracking-[-0.035em] min-[1120px]:text-lg',
          inverse ? 'text-white' : 'text-[var(--color-text)]',
        )}
      >
        Safety
        <span className={inverse ? 'text-white/65' : 'text-[var(--color-text-muted)]'}>HUB</span>
      </span>
    </div>
  );
}
