'use client';

import { useSyncExternalStore } from 'react';
import { getThemeSnapshot, subscribeToTheme } from '@/lib/theme';

/**
 * Whether the dark theme is showing. Every control that reads it — the header
 * switch, the menu item — follows the same `dark` class, so two of them on one
 * page cannot disagree. The server has no theme, hence `false` until hydration.
 */
export function useIsDarkTheme() {
  return useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => false);
}
