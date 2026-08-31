'use client';

import { useSyncExternalStore } from 'react';
import { applyDocumentTheme } from '@/lib/theme';

const THEME_CHANGE_EVENT = 'safetyhub:theme-change';

function subscribeToTheme(onStoreChange: () => void) {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('storage', onStoreChange);
  window.addEventListener(THEME_CHANGE_EVENT, onStoreChange);

  return () => {
    observer.disconnect();
    window.removeEventListener('storage', onStoreChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onStoreChange);
  };
}

function getThemeSnapshot() {
  return document.documentElement.classList.contains('dark');
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = !root.classList.contains('dark');
  applyDocumentTheme(dark);

  try {
    window.localStorage.setItem('theme', dark ? 'dark' : 'light');
  } catch {
    // The selected theme still applies for the current session.
  }

  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

export function ThemeToggle() {
  const isDark = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, () => false);

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={
        isDark ? 'Тёмная тема. Переключить на светлую' : 'Светлая тема. Переключить на тёмную'
      }
      onClick={toggleTheme}
      className="glass group inline-flex h-11 min-w-[6.25rem] shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] px-2.5 whitespace-nowrap text-[var(--color-text)] transition-[color,background-color,border-color] duration-150 hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-elevated)]"
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="size-[18px] shrink-0 dark:hidden"
        fill="none"
      >
        <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.8" />
        <path
          d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.41M17.66 6.34l1.41-1.41"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        className="hidden size-[18px] shrink-0 dark:block"
        fill="none"
      >
        <path
          d="M20.3 15.7A8.5 8.5 0 0 1 8.3 3.7 8.5 8.5 0 1 0 20.3 15.7Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
      <span aria-hidden="true" className="text-xs leading-none font-semibold">
        <span className="dark:hidden">Светлая</span>
        <span className="hidden dark:inline">Тёмная</span>
      </span>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-[var(--color-primary)] opacity-75 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}
