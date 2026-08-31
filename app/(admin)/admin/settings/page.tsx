export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { SiteContactsForm } from '@/components/admin/site-contacts-form';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { requireCapability } from '@/features/auth/server';
import { readSiteContactsUncached } from '@/lib/site-contacts';

export default async function AdminSettingsPage() {
  await requireCapability('site.settings.manage');
  const settings = await readSiteContactsUncached();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Контакты сайта, справочники и история действий.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex min-h-32 flex-col items-start justify-between gap-3 p-5">
            <div>
              <h2 className="font-bold">Мой аккаунт</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Фотография, имя, компания и параметры входа администратора.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/account">Открыть аккаунт</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex min-h-32 flex-col items-start justify-between gap-3 p-5">
            <div>
              <h2 className="font-bold">Компании</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Найти дубли, проверить последствия и объединить записи.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/organizations/cleanup">Открыть справочник</Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex min-h-32 flex-col items-start justify-between gap-3 p-5">
            <div>
              <h2 className="font-bold">История действий</h2>
              <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                Кто, когда и над какими данными выполнил операцию.
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/settings/history">Открыть историю</Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <div>
            <h2 className="text-xl font-bold">Контакты сайта</h2>
            <p className="text-sm text-[var(--color-text-muted)]">
              Публичные реквизиты и каналы связи.
            </p>
          </div>
          <SiteContactsForm initialSettings={settings} />
        </CardContent>
      </Card>
    </div>
  );
}
