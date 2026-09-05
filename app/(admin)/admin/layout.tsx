export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Article } from '@phosphor-icons/react/dist/ssr/Article';
import { CheckSquareOffset } from '@phosphor-icons/react/dist/ssr/CheckSquareOffset';
import { ClipboardText } from '@phosphor-icons/react/dist/ssr/ClipboardText';
import { UserCircleCheck } from '@phosphor-icons/react/dist/ssr/UserCircleCheck';
import { House } from '@phosphor-icons/react/dist/ssr/House';
import { Gear } from '@phosphor-icons/react/dist/ssr/Gear';
import { Users } from '@phosphor-icons/react/dist/ssr/Users';
import { AdminMoreMenu } from '@/components/admin/admin-more-menu';
import { AdminNavLink } from '@/components/admin/admin-nav-link';
import {
  AdminNotificationInboxButton,
  AdminNotificationInboxProvider,
} from '@/components/admin/admin-notification-inbox';
import { UserMenu } from '@/components/shared/user-menu';
import { Container } from '@/components/ui/container';
import { AuthenticationError, requireAnyCapability } from '@/features/auth/server';
import { ADMIN_CAPABILITIES } from '@/lib/security/capabilities';
import { rolloutFeatureEnabled } from '@/lib/release/rollout-flags';

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
    { href: employeeHref, icon: Users, label: 'Сотрудники' },
    { href: '/admin/courses', icon: ClipboardText, label: 'Курсы' },
    { href: '/admin/articles', icon: Article, label: 'Материалы' },
    { href: '/admin/settings', icon: Gear, label: 'Настройки' },
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
      <div
        data-admin-shell
        className="min-h-dvh bg-[var(--color-bg)] min-[1024px]:grid min-[1024px]:grid-cols-[13.5rem_minmax(0,1fr)]"
      >
        <a
          href="#admin-main"
          className="fixed top-2 left-2 z-[70] -translate-y-24 rounded-lg bg-[var(--color-surface)] px-4 py-3 font-bold shadow-[var(--shadow-pop)] focus:translate-y-0"
        >
          К содержанию
        </a>

        <aside className="sticky top-0 hidden h-dvh min-h-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3 min-[1024px]:flex">
          <Link
            href="/admin"
            className="flex min-h-12 items-center gap-3 rounded-xl px-2"
          >
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
            <div className="flex min-h-11 items-center justify-between gap-2 px-3">
              <span className="text-sm font-bold text-[var(--color-text-muted)]">Аккаунт</span>
              <div className="flex items-center gap-1">
                <AdminNotificationInboxButton placement="desktop" />
                <UserMenu
                  email={actor.user.email ?? ''}
                  fullName={fullName}
                  isAdmin
                  avatarUrl={avatarUrl}
                />
              </div>
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
          <header className="sticky top-0 z-40 flex min-h-14 items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 pt-[var(--safe-area-top)] pr-[max(1rem,var(--safe-area-right))] pl-[max(1rem,var(--safe-area-left))] backdrop-blur-xl min-[1024px]:hidden">
            <Link href="/admin" className="min-w-0 py-2">
              <span className="block truncate text-sm font-black">SafetyHub Admin</span>
            </Link>
            <div className="flex items-center gap-1">
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
                avatarUrl={avatarUrl}
              />
            </div>
          </header>

          <main
            id="admin-main"
            className="min-w-0 pb-[calc(var(--mobile-fixed-bottom-space)+1.5rem)] min-[1024px]:pb-0"
          >
            <Container
              size="admin"
              data-admin-workspace
              className="admin-workspace-container py-4 sm:py-5 md:py-6"
            >
              {children}
            </Container>
          </main>

          <nav
            aria-label="Мобильная навигация админ-панели"
            className="fixed inset-x-0 bottom-0 z-50 overflow-x-hidden border-t border-[var(--color-border)] bg-[var(--color-surface)]/95 pb-[var(--safe-area-bottom)] backdrop-blur-xl min-[1024px]:hidden"
          >
            <div className="grid min-h-[var(--mobile-tab-height)] grid-cols-5 px-[max(.25rem,var(--safe-area-left))] py-1 pr-[max(.25rem,var(--safe-area-right))]">
              {items.slice(0, 4).map(({ href, icon: Icon, label }) => (
                <AdminNavLink key={href} href={href} label={label} mobile>
                  <Icon size={20} />
                </AdminNavLink>
              ))}
              <AdminMoreMenu items={items.slice(4).map(({ href, label }) => ({ href, label }))} />
            </div>
          </nav>
        </div>
      </div>
    </AdminNotificationInboxProvider>
  );
}
