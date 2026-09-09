'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Renders an overlay into `document.body`.
 *
 * The admin workspace declares `container-type: inline-size` so its tables can
 * respond to the width the sidebar leaves them. Per CSS containment that also
 * makes the element a containing block for every `position: fixed` descendant,
 * so a dialog inside it is positioned against the whole scrollable workspace
 * rather than the viewport: on a long page — the material list, the audit log —
 * pressing "Delete" appeared to do nothing, because the confirmation rendered
 * hundreds of pixels below the fold. The container query cannot be given up
 * (the table depends on it), so the overlays leave the container instead.
 *
 * Scroll locking lives here as well: every other modal in the product freezes
 * the page behind it, and the destructive confirmation was the one that did not.
 */
export function AdminOverlay({
  children,
  lockScroll = true,
}: {
  children: ReactNode;
  lockScroll?: boolean;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || !lockScroll) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [lockScroll, mounted]);

  // `createPortal` needs a real document, so the first server render and the
  // hydration pass both produce nothing.
  if (!mounted) return null;
  return createPortal(children, document.body);
}
