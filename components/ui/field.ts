/**
 * One look and one focus state for every text field, textarea and select.
 *
 * Focus is the field's own border taking the primary colour with a soft halo
 * flush against it, so the eye reads a single frame. The admin shell used to
 * add a second outline on top of each field's own one, in a different colour
 * and at a different offset. It is an outline rather than a shadow because
 * forced-colors mode keeps outlines and drops shadows.
 */
export const fieldBase =
  'w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] text-base text-[var(--color-text)] shadow-[var(--shadow-soft)] transition placeholder:text-[var(--color-text-subtle)] hover:border-[var(--color-border-strong)] disabled:cursor-not-allowed disabled:opacity-60 sm:text-sm';

export const fieldFocus =
  'focus-visible:border-[var(--color-primary)] focus-visible:outline-[3px] focus-visible:outline-offset-0 focus-visible:outline-[var(--color-primary-ring)]';

/**
 * For a frame that holds a bare input beside a word («с … по …»): the input
 * inside draws no outline of its own, so the frame shows the same focus state.
 */
export const fieldFrameFocus =
  'focus-within:border-[var(--color-primary)] focus-within:outline-[3px] focus-within:outline-offset-0 focus-within:outline-[var(--color-primary-ring)]';

export const fieldInvalid =
  'border-[var(--color-danger)] hover:border-[var(--color-danger)] focus-visible:border-[var(--color-danger)] focus-visible:outline-[var(--color-danger-soft)]';
