export const dynamic = 'force-dynamic';

import { LegalLocalizationsEditor } from '@/components/admin/legal-localizations-editor';
import { listLegalLocalizationVersions } from '@/features/admin/localizations-server';

export default async function AdminLegalLocalizationsPage() {
  const versions = await listLegalLocalizationVersions();
  return (
    <section className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold">Юридические документы</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Четыре неизменяемые локализации одной канонической версии. Публикация выполняется
          атомарно.
        </p>
      </div>
      <LegalLocalizationsEditor versions={versions} />
    </section>
  );
}
