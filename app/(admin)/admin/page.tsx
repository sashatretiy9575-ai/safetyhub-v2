export const dynamic = 'force-dynamic';

import Link from 'next/link';
import {
  Buildings,
  CaretRight,
  Certificate,
  CheckCircle,
  Plus,
  UserCircleCheck,
} from '@phosphor-icons/react/dist/ssr';
import { AdminLoadFailure } from '@/components/admin/admin-data-state';
import { Button } from '@/components/ui/button';
import { getAdminWorkQueue } from '@/server/admin/attestations';
import { getPendingAccountApprovalPage } from '@/server/admin/data';
import { requireCapability } from '@/server/auth/session';

export default async function AdminWorkPage() {
  const actor = await requireCapability('results.read');
  const canManageIdentity = actor.capabilities.includes('identity.manage');
  const [queue, approvals] = await Promise.all([
    getAdminWorkQueue(),
    canManageIdentity
      ? getPendingAccountApprovalPage({ cursorAt: null, cursorId: null })
      : Promise.resolve(null),
  ]);

  const queueItems = [
    ...(canManageIdentity
      ? [
          {
            key: 'approvals',
            label: 'Новые заявки',
            href: '/admin/approvals',
            count: approvals?.state === 'ready' ? approvals.data.total : 0,
            icon: UserCircleCheck,
          },
        ]
      : []),
    {
      key: 'pendingIdentity',
      label: 'Проверить данные',
      href: '/admin/employees?certificate=pending_identity&sort=organization_asc',
      count: queue.state === 'ready' ? queue.data.pendingIdentity : 0,
      icon: CheckCircle,
    },
    {
      key: 'readyToIssue',
      label: 'Выдать сертификаты',
      href: '/admin/employees?certificate=ready&sort=organization_asc',
      count: queue.state === 'ready' ? queue.data.readyToIssue : 0,
      icon: Certificate,
    },
    {
      key: 'companyIssues',
      label: 'Очистить компании',
      href: '/admin/organizations/cleanup',
      count: queue.state === 'ready' ? queue.data.companyIssues : 0,
      icon: Buildings,
    },
  ];

  return (
    <section className="space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold">В работе</h1>
      </div>

      {queue.state === 'failed' ? (
        <AdminLoadFailure
          correlationId={queue.correlationId}
          message="Рабочие очереди временно не загрузились."
        />
      ) : (
        <nav
          aria-label="Рабочие очереди"
          className="grid overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] sm:grid-cols-2"
        >
          {queueItems.map(({ key, label, href, count, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              // Four tiles in one row truncated their own labels on a laptop;
              // two per row leave room for the words and the number.
              className="group grid min-h-16 min-w-0 grid-cols-[2.75rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-4 py-3 transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)] sm:[&:nth-child(odd)]:border-r sm:[&:nth-last-child(-n+2)]:border-b-0"
            >
              <span className="grid size-11 place-items-center rounded-xl bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <Icon size={22} />
              </span>
              <span className="min-w-0 text-base font-bold break-words">{label}</span>
              <strong className="text-2xl font-black tabular-nums">{count}</strong>
              <CaretRight
                aria-hidden
                size={16}
                className="text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
              />
            </Link>
          ))}
        </nav>
      )}

      <section aria-labelledby="quick-create-title" className="space-y-3">
        <h2 id="quick-create-title" className="font-display text-xl font-bold">
          Создать
        </h2>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href="/admin/courses/new">
              <Plus /> Новый курс
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href="/admin/articles/new">
              <Plus /> Новый материал
            </Link>
          </Button>
        </div>
      </section>
    </section>
  );
}
