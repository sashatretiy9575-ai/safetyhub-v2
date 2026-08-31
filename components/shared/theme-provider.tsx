'use client';

import { useEffect, type ReactNode } from 'react';
import { applyDocumentTheme, preferredDarkTheme, THEME_BOOTSTRAP } from '@/lib/theme';

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
      {children}
    </>
  );
}
