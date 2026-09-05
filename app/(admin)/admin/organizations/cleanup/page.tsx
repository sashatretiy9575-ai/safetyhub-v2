export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr';
import { OrganizationCleanupManager } from '@/components/admin/organization-cleanup-manager';
import { AdminLoadFailure } from '@/components/admin/admin-data-state';
import { Button } from '@/components/ui/button';
import { getOrganizationCleanupClusters } from '@/features/admin/organizations';

export default async function OrganizationCleanupPage() {
  const result = await getOrganizationCleanupClusters();
  return (
    <section className="space-y-6">
      <div>
        <Button asChild size="sm" variant="ghost" className="mb-2">
          <Link href="/admin/employees"><ArrowLeft /> Сотрудники</Link>
        </Button>
        <h1 className="font-display text-3xl font-bold">Очистка компаний</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
          Объединение похожих названий подтверждает администратор.
        </p>
      </div>
      {result.state === 'failed' ? (
        <AdminLoadFailure correlationId={result.correlationId} />
      ) : (
        <OrganizationCleanupManager clusters={result.data} />
      )}
    </section>
  );
}
