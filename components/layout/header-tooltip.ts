/**
 * The hover/focus tooltip under the 44 px icon controls of the sticky header.
 * The owning control must carry the `group` class; the tooltip itself is
 * decorative — the control's `aria-label` is the accessible name.
 */
export const headerTooltipClass =
  'pointer-events-none absolute left-1/2 top-[calc(100%+0.625rem)] z-50 -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-control)] bg-[var(--color-text)] px-2.5 py-1.5 text-xs font-semibold text-[var(--color-bg)] opacity-0 shadow-[var(--shadow-pop)] transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100';
