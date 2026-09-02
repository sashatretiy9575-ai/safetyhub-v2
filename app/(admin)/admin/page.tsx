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
import { getAdminWorkQueue } from '@/features/admin/attestations';
import { getPendingAccountApprovalPage } from '@/features/admin/data';
import { requireCapability } from '@/features/auth/server';

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
            description: 'Пользователи, ожидающие ручной проверки и открытия доступа.',
            href: '/admin/approvals',
            count: approvals?.state === 'ready' ? approvals.data.total : 0,
            icon: UserCircleCheck,
          },
        ]
      : []),
    {
      key: 'pendingIdentity',
      label: 'Проверить данные',
      description: 'Участники с изменёнными или ещё не подтверждёнными данными.',
      href: '/admin/employees?certificate=pending_identity&sort=organization_asc',
      count: queue.state === 'ready' ? queue.data.pendingIdentity : 0,
      icon: CheckCircle,
    },
    {
      key: 'readyToIssue',
      label: 'Выдать сертификаты',
      description: 'Сданные курсы с подтверждёнными данными, готовые к выдаче.',
      href: '/admin/employees?certificate=ready&sort=organization_asc',
      count: queue.state === 'ready' ? queue.data.readyToIssue : 0,
      icon: Certificate,
    },
    {
      key: 'companyIssues',
      label: 'Очистить компании',
      description: 'Похожие или ещё не связанные с каталогом названия компаний.',
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
          className="grid overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] sm:grid-cols-2 lg:grid-cols-4"
        >
          {queueItems.map(({ key, label, description, href, count, icon: Icon }) => (
            <Link
              key={key}
              href={href}
              title={description}
              className="group grid min-h-14 min-w-0 grid-cols-[2.5rem_minmax(0,1fr)_auto_auto] items-center gap-3 border-b px-3 py-2 transition-colors last:border-b-0 hover:bg-[var(--color-surface-muted)] sm:border-r sm:border-b-0 sm:last:border-r-0"
            >
              <span className="grid size-9 place-items-center rounded-lg bg-[var(--color-primary-soft)] text-[var(--color-primary)]">
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{label}</span>
              </span>
              <strong className="text-xl font-black tabular-nums">{count}</strong>
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
