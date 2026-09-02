export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { SiteContactsForm } from '@/components/admin/site-contacts-form';
import { Buildings, CaretRight, ClockCounterClockwise, User } from '@phosphor-icons/react/dist/ssr';
import { requireCapability } from '@/features/auth/server';
import { readSiteContactsUncached } from '@/lib/site-contacts';

export default async function AdminSettingsPage() {
  await requireCapability('site.settings.manage');
  const settings = await readSiteContactsUncached();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Настройки</h1>
      </div>

      <nav
        aria-label="Разделы настроек"
        className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <Link
          href="/admin/account"
          className="group flex min-h-12 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <User size={18} />
            </span>
            <span className="font-semibold text-sm">Мой аккаунт</span>
          </div>
          <CaretRight
            size={16}
            className="text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
        <Link
          href="/admin/organizations/cleanup"
          className="group flex min-h-12 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <Buildings size={18} />
            </span>
            <span className="font-semibold text-sm">Компании</span>
          </div>
          <CaretRight
            size={16}
            className="text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
        <Link
          href="/admin/settings/history"
          className="group flex min-h-12 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]"
        >
          <div className="flex items-center gap-3">
            <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
              <ClockCounterClockwise size={18} />
            </span>
            <span className="font-semibold text-sm">История действий</span>
          </div>
          <CaretRight
            size={16}
            className="text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      </nav>

      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 space-y-4">
        <h2 className="text-lg font-bold">Контакты сайта</h2>
        <SiteContactsForm initialSettings={settings} />
      </section>
    </div>
  );
}
