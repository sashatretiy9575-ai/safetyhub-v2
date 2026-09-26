'use client';

import { useEffect, type ReactNode } from 'react';
import { IconContext } from '@phosphor-icons/react/dist/lib/context';
import type { IconProps } from '@phosphor-icons/react/dist/lib/types';
import { applyDocumentTheme, preferredDarkTheme, THEME_BOOTSTRAP } from '@/lib/theme';

/**
 * Every Phosphor icon is decoration: the words beside it, or the aria-label of
 * the control it sits in, carry the meaning. Phosphor adds no aria-hidden of
 * its own, so an unmarked icon reached a screen reader as an unnamed image.
 * Client icons read this context; an icon that must be announced can still
 * pass `aria-hidden={false}` and an `alt`. The server build (`dist/ssr`) does
 * not read context, so those call sites mark themselves.
 *
 * A provider replaces Phosphor's default value rather than merging with it,
 * and `IconBase` takes the size of an icon without a `size` prop from here —
 * so the library defaults are repeated, or such icons would render 0×0.
 */
const DECORATIVE_ICONS: IconProps = {
  color: 'currentColor',
  size: '1em',
  weight: 'regular',
  mirrored: false,
  'aria-hidden': true,
};

export function ThemeProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncSystemTheme = () => {
      let hasExplicitTheme = false;
      try {
        hasExplicitTheme = ['light', 'dark'].includes(window.localStorage.getItem('theme') ?? '');
      } catch {
        // The system preference is still available when storage is blocked.
      }
      if (!hasExplicitTheme) applyDocumentTheme(media.matches);
    };
    const syncStoredTheme = () => applyDocumentTheme(preferredDarkTheme());

    applyDocumentTheme(preferredDarkTheme());
    document.documentElement.dataset.hydrated = 'true';
    media.addEventListener('change', syncSystemTheme);
    window.addEventListener('storage', syncStoredTheme);
    return () => {
      media.removeEventListener('change', syncSystemTheme);
      window.removeEventListener('storage', syncStoredTheme);
    };
  }, []);

  return (
    <>
      <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      <IconContext.Provider value={DECORATIVE_ICONS}>{children}</IconContext.Provider>
    </>
  );
}
