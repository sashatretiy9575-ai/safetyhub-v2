import { InitialArticleImportForm } from '@/components/admin/initial-article-import-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireCapability } from '@/features/auth/server';
import {
  INITIAL_ARTICLE_IMPORT_CONFIRMATION,
  INITIAL_ARTICLE_SNAPSHOT_COUNT,
  INITIAL_ARTICLE_SNAPSHOT_HASH,
} from '@/lib/content/initial-article-import';

export default async function InitialArticleImportPage() {
  await requireCapability('content.manage');
  return (
    <section className="space-y-5">
      <div>
        <h1 className="font-display text-3xl font-bold">Первичная публикация материалов</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Публикация утверждённого снимка статей.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{INITIAL_ARTICLE_SNAPSHOT_COUNT} статей</CardTitle>
          <CardDescription className="break-all">
            SHA-256: {INITIAL_ARTICLE_SNAPSHOT_HASH}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-[var(--color-text-muted)]">
            Повторный запуск не создаёт дубликаты.
          </p>
          <InitialArticleImportForm confirmation={INITIAL_ARTICLE_IMPORT_CONFIRMATION} />
        </CardContent>
      </Card>
    </section>
  );
}
