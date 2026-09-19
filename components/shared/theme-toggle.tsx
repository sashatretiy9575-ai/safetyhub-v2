'use client';

import { useTranslations } from 'next-intl';
import { Moon, Sun } from '@phosphor-icons/react';
import { useIsDarkTheme } from '@/components/shared/use-theme';
import { toggleTheme } from '@/lib/theme';

export function ThemeToggle() {
  const isDark = useIsDarkTheme();
  const translations = useTranslations('Shell.theme');

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? translations('switchToLight') : translations('switchToDark')}
      onClick={toggleTheme}
      className="group inline-flex size-11 shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] bg-transparent px-0 whitespace-nowrap text-[var(--color-text)] transition-[color,background-color] duration-150 hover:bg-[var(--color-surface-muted)] lg:h-11 lg:w-[7.25rem] lg:px-2.5"
    >
      <Sun
        aria-hidden="true"
        size={18}
        weight="regular"
        className="size-[18px] shrink-0 dark:hidden"
      />
      <Moon
        aria-hidden="true"
        size={18}
        weight="regular"
        className="hidden size-[18px] shrink-0 dark:block"
      />
      <span aria-hidden="true" className="hidden text-xs leading-none font-semibold lg:inline">
        <span className="dark:hidden">{translations('light')}</span>
        <span className="hidden dark:inline">{translations('dark')}</span>
      </span>
      <span
        aria-hidden="true"
        className="hidden size-1.5 shrink-0 rounded-full bg-[var(--color-primary)] opacity-75 transition-opacity group-hover:opacity-100 lg:block"
      />
    </button>
  );
}
