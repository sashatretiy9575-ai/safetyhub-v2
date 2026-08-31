export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { z } from 'zod';
import { LearningHistoryControl } from '@/components/admin/learning-history-control';
import { Button } from '@/components/ui/button';
import { getAdminLearningHistory } from '@/features/admin/server';

const paramsSchema = z.object({ userId: z.string().uuid() });

export default async function EmployeeLearningHistoryPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) throw new Error('INVALID_REQUEST');
  const history = await getAdminLearningHistory(parsed.data.userId);
  const userLabel =
    [history.user.name, history.user.surname].filter(Boolean).join(' ').trim() ||
    history.user.email;

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Учебная история</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {userLabel} · {history.user.email}
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/admin/employees/directory">Все аккаунты</Link>
        </Button>
      </div>
      <div className="rounded-xl border bg-[var(--color-surface)] p-5">
        <LearningHistoryControl
          userId={history.user.id}
          userLabel={userLabel}
          initialHistory={history}
        />
      </div>
    </section>
  );
}
