export const dynamic = 'force-dynamic';

import { LegalLocalizationsEditor } from '@/components/admin/legal-localizations-editor';
import { listLegalLocalizationVersions } from '@/server/admin/localizations';

export default async function AdminLegalLocalizationsPage() {
  const versions = await listLegalLocalizationVersions();
  return (
    <section className="space-y-6">
      <div>
        <h1 className="font-display text-h3 font-bold">Юридические документы</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Privacy и Terms публикуются одним пакетом на четырёх языках.
        </p>
      </div>
      <LegalLocalizationsEditor versions={versions} />
    </section>
  );
}
