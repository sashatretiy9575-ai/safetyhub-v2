/**
 * The page rail classes, kept apart from `Container` so the error and 404
 * boundaries, which load with every route, can use the rail without pulling
 * tailwind-merge into their chunks.
 */
export const CONTAINER_BASE =
  'mx-auto w-full pr-[max(1rem,var(--safe-area-right))] pl-[max(1rem,var(--safe-area-left))] md:pr-[max(1.5rem,var(--safe-area-right))] md:pl-[max(1.5rem,var(--safe-area-left))] xl:pr-[max(2rem,var(--safe-area-right))] xl:pl-[max(2rem,var(--safe-area-left))]';

export const CONTAINER_SIZES = {
  narrow: 'max-w-[760px]',
  content: 'max-w-[1120px]',
  wide: 'max-w-[1280px]',
  admin: 'max-w-[1800px]',
} as const;

/** The narrow rail the emergency screens sit in. */
export const EMERGENCY_CONTAINER = `${CONTAINER_BASE} ${CONTAINER_SIZES.narrow}`;
