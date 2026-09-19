export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Article } from '@phosphor-icons/react/dist/ssr/Article';
import { CheckSquareOffset } from '@phosphor-icons/react/dist/ssr/CheckSquareOffset';
import { ClipboardText } from '@phosphor-icons/react/dist/ssr/ClipboardText';
import { UserCircleCheck } from '@phosphor-icons/react/dist/ssr/UserCircleCheck';
import { House } from '@phosphor-icons/react/dist/ssr/House';
import { Users } from '@phosphor-icons/react/dist/ssr/Users';
import { AdminNavLink } from '@/components/admin/admin-nav-link';
import {
  AdminNotificationInboxButton,
  AdminNotificationInboxProvider,
} from '@/components/admin/admin-notification-inbox';
import { UserMenu } from '@/components/shared/user-menu';
import { Container } from '@/components/ui/container';
import { AuthenticationError, requireAnyCapability } from '@/server/auth/session';
import { ADMIN_CAPABILITIES } from '@/lib/security/capabilities';
import { rolloutFeatureEnabled } from '@/lib/rollout-flags';
import { ConfirmDialogHost } from '@/components/admin/confirm-dialog';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let actor: Awaited<ReturnType<typeof requireAnyCapability>>;
  try {
    actor = await requireAnyCapability(ADMIN_CAPABILITIES);
  } catch (error) {
    if (error instanceof AuthenticationError && error.status === 401) redirect('/auth/login');
    if (error instanceof AuthenticationError && error.status === 503) throw error;
    redirect('/profile');
  }

  const employeeHref = actor.capabilities.includes('results.read')
    ? '/admin/employees'
    : actor.capabilities.includes('results.delete')
      ? '/admin/employees/directory'
      : '/admin';
  const items = [
    { href: '/admin', icon: CheckSquareOffset, label: 'В работе' },
    { href: '/admin/approvals', icon: UserCircleCheck, label: 'Заявки' },
    { href: employeeHref, icon: Users, label: 'Сотрудники', shortLabel: 'Люди' },
    { href: '/admin/courses', icon: ClipboardText, label: 'Курсы' },
    { href: '/admin/articles', icon: Article, label: 'Материалы' },
  ];

  const fullName = `${actor.profile.name ?? ''} ${actor.profile.surname ?? ''}`.trim() || undefined;
  // The header picture is served from its own address instead of a signed URL
  // resolved here: two Supabase round-trips used to sit on the critical path of
  // every admin navigation for a decorative avatar.
  const avatarUrl = actor.profile.avatar_updated_at ? '/api/profile/avatar' : null;
  const notificationsEnabled =
    rolloutFeatureEnabled('adminInbox') &&
    (actor.capabilities.includes('notifications.read') ||
      actor.capabilities.includes('audit.read'));

  return (
    <AdminNotificationInboxProvider enabled={notificationsEnabled}>
      <ConfirmDialogHost />
      <div
        data-admin-shell
        className="min-h-dvh bg-[var(--color-bg)] lg:grid lg:grid-cols-[13.5rem_minmax(0,1fr)]"
      >
        <a
          href="#admin-main"
          className="fixed top-2 left-2 z-[70] w-fit max-w-[calc(100vw-1rem)] min-w-0 -translate-y-[calc(100%+1rem)] rounded-lg bg-[var(--color-surface)] px-4 py-3 font-bold [overflow-wrap:anywhere] whitespace-normal shadow-[var(--shadow-pop)] focus:translate-y-0"
        >
          К содержанию
        </a>

        <aside className="sticky top-0 hidden h-dvh min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3 lg:flex">
          <Link href="/admin" className="flex min-h-12 items-center gap-3 rounded-xl px-2">
            <span className="grid size-10 place-items-center rounded-xl bg-[var(--color-primary)] font-black text-[var(--color-primary-foreground)]">
              S
            </span>
            <span className="min-w-0">
              <span className="block font-black">SafetyHub</span>
              <span className="block truncate text-xs text-[var(--color-text-muted)]">
                Админ-панель
              </span>
            </span>
          </Link>

          <nav
            aria-label="Навигация админ-панели"
            className="mt-6 min-h-0 flex-1 space-y-1 overflow-y-auto"
          >
            {items.map(({ href, icon: Icon, label }) => (
              <AdminNavLink key={href} href={href} label={label}>
                <Icon size={19} />
              </AdminNavLink>
            ))}
          </nav>

          <div className="mt-4 space-y-2 border-t border-[var(--color-border)] pt-4">
            <div className="flex min-h-11 items-center gap-1 px-3">
              <AdminNotificationInboxButton placement="desktop" />
              <UserMenu
                email={actor.user.email ?? ''}
                fullName={fullName}
                isAdmin
                canManageSiteSettings={actor.capabilities.includes('site.settings.manage')}
                canReadAudit={actor.capabilities.includes('audit.read')}
                avatarUrl={avatarUrl}
                showThemeToggle
              />
            </div>
            <Link
              href="/"
              className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-bold text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
            >
              <House size={19} />
              На сайт
            </Link>
          </div>
        </aside>

        <div className="min-w-0">
          <header
            data-admin-mobile-header
            className="sticky top-0 z-40 flex min-h-14 min-w-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 pt-[var(--safe-area-top)] pr-[max(1rem,var(--safe-area-right))] pl-[max(1rem,var(--safe-area-left))] backdrop-blur-xl lg:hidden"
          >
            <Link href="/admin" className="min-w-0 flex-1 py-2">
              <span className="block truncate text-sm font-black">SafetyHub Admin</span>
            </Link>
            <div className="flex max-w-full min-w-0 flex-wrap items-center justify-end gap-1">
              <AdminNotificationInboxButton placement="mobile" />
              <Link
                href="/"
                aria-label="На сайт"
                className="grid size-11 place-items-center rounded-full text-[var(--color-text-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                <House size={20} />
              </Link>
              <UserMenu
                email={actor.user.email ?? ''}
                fullName={fullName}
                isAdmin
                canManageSiteSettings={actor.capabilities.includes('site.settings.manage')}
                canReadAudit={actor.capabilities.includes('audit.read')}
                avatarUrl={avatarUrl}
                showThemeToggle
              />
            </div>
          </header>

          <main
            id="admin-main"
            // Without tabIndex the skip link moves the viewport and leaves
            // focus on <body>, and without the scroll margin the heading it
            // jumps to sits under the sticky header.
            tabIndex={-1}
            // The reserve follows the dock: two rows of it below 360 px, one above.
            className="min-w-0 scroll-mt-[calc(3.5rem+var(--safe-area-top))] pb-[calc(var(--mobile-fixed-bottom-space)+5rem)] outline-none min-[360px]:pb-[calc(var(--mobile-fixed-bottom-space)+1.5rem)] lg:scroll-mt-0 lg:pb-0"
          >
            <Container
              size="admin"
              data-admin-workspace
              className="admin-workspace-container py-4 sm:py-5 md:py-6"
            >
              {children}
            </Container>
          </main>

          {/* The public site's dock, without its fixed height: below 360 px the
              five items wrap to two rows and the pill grows with them. A short
              window un-sticks it (globals.css); the side insets stop applying
              there, so `mx-auto` keeps it centred and `mt-2` lifts it off the
              header — a top margin does not move a box pinned by its bottom. */}
          <nav
            data-admin-mobile-nav
            aria-label="Мобильная навигация админ-панели"
            className="glass-strong fixed right-[max(.625rem,var(--safe-area-right))] bottom-[var(--safe-area-bottom)] left-[max(.625rem,var(--safe-area-left))] z-50 mx-auto mt-2 max-w-[32.5rem] rounded-[var(--radius-dock)] p-0.5 lg:hidden"
          >
            <div className="grid grid-cols-3 gap-0.5 min-[360px]:grid-cols-5">
              {items.map(({ href, icon: Icon, label, shortLabel }) => (
                <AdminNavLink key={href} href={href} label={label} shortLabel={shortLabel} mobile>
                  <Icon size={21} weight="regular" />
                </AdminNavLink>
              ))}
            </div>
          </nav>
        </div>
      </div>
    </AdminNotificationInboxProvider>
  );
}
