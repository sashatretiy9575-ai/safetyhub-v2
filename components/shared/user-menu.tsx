'use client';

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import {
  ClockCounterClockwise,
  DownloadSimple,
  Gauge,
  Gear,
  User,
  UserGear,
} from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Link from '@/components/shared/navigation-link';
import { useRouter } from 'next/navigation';
import { ROUTES } from '@/lib/constants';
import { usePWA } from '@/components/shared/pwa-provider';
import { detectInstallPlatform } from '@/components/shared/install-platform';
import { SignOutAction } from '@/components/shared/sign-out-action';
import { localizePathname } from '@/i18n/config';

export type UserMenuProps = {
  email: string;
  fullName?: string;
  isAdmin?: boolean;
  canManageSiteSettings?: boolean;
  canReadAudit?: boolean;
  avatarUrl?: string | null;
};

export function UserMenu({
  email,
  fullName,
  isAdmin,
  canManageSiteSettings = false,
  canReadAudit = false,
  avatarUrl,
}: UserMenuProps) {
  const router = useRouter();
  const locale = useLocale();
  const translations = useTranslations('Shell.userMenu');
  // Three components each ran their own copy of the install hook, so three
  // listeners answered one browser event and could disagree about whether the
  // app was installable. The menu renders inside PWAProvider in both private
  // roots, so it reads the shared answer.
  const { install, isInstallable, isInstalled } = usePWA();
  // iPhone always has the steps to offer; any other browser only its own sheet.
  const [ios, setIos] = useState(false);
  useEffect(() => setIos(detectInstallPlatform() === 'ios'), []);
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
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) {
          router.prefetch(isAdmin ? ROUTES.adminAccount : localizePathname(ROUTES.profile, locale));
          if (isAdmin) router.prefetch(ROUTES.admin);
        }
      }}
    >
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
              {/* An administrator without a photo gets the administrator icon
                  rather than two letters of their name. */}
              {isAdmin ? (
                <UserGear size={20} weight="regular" aria-hidden="true" />
              ) : (
                initials || <User size={18} weight="regular" />
              )}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="glass-strong max-h-[var(--radix-dropdown-menu-content-available-height)] w-56 max-w-[calc(100vw-1rem)] min-w-0 overflow-y-auto rounded-[var(--radius-card)] border-[var(--glass-border)] p-2 shadow-[var(--shadow-pop)]"
      >
        <DropdownMenuItem
          asChild
          className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
        >
          <Link href={isAdmin ? ROUTES.admin : localizePathname(ROUTES.profile, locale)}>
            <div className="flex min-w-0 items-center gap-3">
              {isAdmin ? (
                <Gauge size={18} weight="regular" className="text-[var(--color-text-muted)]" />
              ) : (
                <User size={18} weight="regular" className="text-[var(--color-text-muted)]" />
              )}
              <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
                {isAdmin ? translations('admin') : translations('profile')}
              </span>
            </div>
          </Link>
        </DropdownMenuItem>

        {isAdmin ? (
          <DropdownMenuItem
            asChild
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
          >
            <Link href={ROUTES.adminAccount}>
              <div className="flex min-w-0 items-center gap-3">
                <User size={18} weight="regular" className="text-[var(--color-text-muted)]" />
                <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
                  {translations('account')}
                </span>
              </div>
            </Link>
          </DropdownMenuItem>
        ) : null}

        {isAdmin && canManageSiteSettings ? (
          <DropdownMenuItem
            asChild
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
          >
            <Link
              href="/admin/settings"
              className="flex min-w-0 items-center gap-3 [overflow-wrap:anywhere] whitespace-normal"
            >
              <Gear size={18} className="shrink-0 text-[var(--color-text-muted)]" />
              <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
                {translations('siteSettings')}
              </span>
            </Link>
          </DropdownMenuItem>
        ) : null}

        {isAdmin && canReadAudit && !canManageSiteSettings ? (
          <DropdownMenuItem
            asChild
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
          >
            <Link
              href="/admin/audit"
              className="flex min-w-0 items-center gap-3 [overflow-wrap:anywhere] whitespace-normal"
            >
              <ClockCounterClockwise
                size={18}
                className="shrink-0 text-[var(--color-text-muted)]"
              />
              <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
                {translations('history')}
              </span>
            </Link>
          </DropdownMenuItem>
        ) : null}

        {!isInstalled && (ios || isInstallable) ? (
          <DropdownMenuItem
            className="min-h-11 cursor-pointer rounded-[var(--radius-control)] py-2 focus:bg-[var(--color-surface-muted)]"
            onSelect={() => void handleInstall()}
          >
            <div className="flex min-w-0 items-center gap-3">
              <DownloadSimple
                size={18}
                weight="regular"
                className="text-[var(--color-text-muted)]"
              />
              <span className="text-sm font-medium [overflow-wrap:anywhere] whitespace-normal">
                {translations('install')}
              </span>
            </div>
          </DropdownMenuItem>
        ) : null}

        <DropdownMenuSeparator className="my-2 bg-[var(--color-border)]" />

        <SignOutAction menuItem />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
