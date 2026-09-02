'use client';

import { useLocale, useTranslations } from 'next-intl';
import { DownloadSimple, Gauge, User } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRouter } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { usePwaInstall } from '@/components/shared/use-pwa-install';
import { SignOutAction } from '@/components/shared/sign-out-action';
import { localizePathname } from '@/i18n/config';

export type UserMenuProps = {
  email: string;
  fullName?: string;
  isAdmin?: boolean;
  avatarUrl?: string | null;
};

export function UserMenu({ email, fullName, isAdmin, avatarUrl }: UserMenuProps) {
  const router = useRouter();
  const locale = useLocale();
  const translations = useTranslations('Shell.userMenu');
  const { install, isInstallable, isStandalone } = usePwaInstall();
  const initials = (fullName ?? email)
    .split(/[\s@]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  const handleInstall = async () => {
    if (isInstallable) {
      const outcome = await install();
      if (outcome === 'accepted') return;
    }
    const accountRoute = isAdmin ? ROUTES.adminAccount : localizePathname(ROUTES.profile, locale);
    router.push(`${accountRoute}#install-app`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={translations('label', { suffix: fullName ? `, ${fullName}` : '' })}
          aria-haspopup="menu"
          className="overflow-hidden rounded-full bg-transparent shadow-none hover:bg-[var(--color-surface-muted)]"
        >
          <Avatar className="size-9 rounded-full">
            {avatarUrl ? (
              <AvatarImage src={avatarUrl} alt="" className="size-full rounded-full object-cover" />
            ) : null}
            <AvatarFallback className="rounded-full bg-[var(--color-surface-muted)] text-xs font-semibold text-[var(--color-text)]">
              {initials || <User size={18} weight="regular" />}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="glass-strong min-w-56 rounded-[var(--radius-card)] border-[var(--glass-border)] p-2 shadow-[var(--shadow-pop)]"
      >
        <DropdownMenuItem
          className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
          onSelect={() =>
            router.push(isAdmin ? ROUTES.admin : localizePathname(ROUTES.profile, locale))
          }
        >
          <div className="flex items-center gap-3">
            {isAdmin ? (
              <Gauge size={18} weight="regular" className="text-[var(--color-text-muted)]" />
            ) : (
              <User size={18} weight="regular" className="text-[var(--color-text-muted)]" />
            )}
            <span className="text-sm font-medium">
              {isAdmin ? translations('admin') : translations('profile')}
            </span>
          </div>
        </DropdownMenuItem>

        {isAdmin ? (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
            onSelect={() => router.push(ROUTES.adminAccount)}
          >
            <div className="flex items-center gap-3">
              <User size={18} weight="regular" className="text-[var(--color-text-muted)]" />
              <span className="text-sm font-medium">{translations('account')}</span>
            </div>
          </DropdownMenuItem>
        ) : null}

        {!isStandalone ? (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
            onSelect={() => void handleInstall()}
          >
            <div className="flex items-center gap-3">
              <DownloadSimple
                size={18}
                weight="regular"
                className="text-[var(--color-text-muted)]"
              />
              <span className="text-sm font-medium">{translations('install')}</span>
            </div>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator className="my-2 bg-[var(--color-border)]" />

        <SignOutAction menuItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
