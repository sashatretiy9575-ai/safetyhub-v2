'use client';

import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Moon, Sun } from '@phosphor-icons/react';
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
  const translations = useTranslations('Shell.theme');

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? translations('switchToLight') : translations('switchToDark')}
      onClick={toggleTheme}
      className="group inline-flex size-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-transparent px-0 whitespace-nowrap text-[var(--color-text)] transition-[color,background-color] duration-150 hover:bg-[var(--color-surface-muted)] min-[1024px]:h-11 min-[1024px]:w-auto min-[1024px]:min-w-[6.25rem] min-[1024px]:px-2.5"
    >
      <Sun aria-hidden="true" size={18} weight="regular" className="size-[18px] shrink-0 dark:hidden" />
      <Moon aria-hidden="true" size={18} weight="regular" className="hidden size-[18px] shrink-0 dark:block" />
      <span
        aria-hidden="true"
        className="hidden text-xs leading-none font-semibold min-[1024px]:inline"
      >
        <span className="dark:hidden">{translations('light')}</span>
        <span className="hidden dark:inline">{translations('dark')}</span>
      </span>
      <span
        aria-hidden="true"
        className="hidden size-1.5 shrink-0 rounded-full bg-[var(--color-primary)] opacity-75 transition-opacity group-hover:opacity-100 min-[1024px]:block"
      />
    </button>
  );
}
