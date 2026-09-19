'use client';

import { useTranslations } from 'next-intl';
import { Moon, Sun } from '@phosphor-icons/react';
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu';
import { useIsDarkTheme } from '@/components/shared/use-theme';
import { toggleTheme } from '@/lib/theme';

/**
 * The theme setting for a menu. The header's switch button is not a valid child
 * of a menu, so inside one the same setting is a `menuitemcheckbox`: checked
 * means dark, and the wording matches the header control. The menu stays open
 * after a change — the result is the whole screen repainting behind it — and
 * the row is laid out like its neighbours in the user menu.
 */
export function ThemeMenuItem() {
  const isDark = useIsDarkTheme();
  const t = useTranslations('Shell.theme');
  const Icon = isDark ? Moon : Sun;

  return (
    <DropdownMenuCheckboxItem
      checked={isDark}
      onCheckedChange={toggleTheme}
      onSelect={(event) => event.preventDefault()}
      aria-label={isDark ? t('switchToLight') : t('switchToDark')}
      className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Icon size={18} weight="regular" className="text-[var(--color-text-muted)]" />
        <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
          {isDark ? t('dark') : t('light')}
        </span>
      </div>
    </DropdownMenuCheckboxItem>
  );
}
