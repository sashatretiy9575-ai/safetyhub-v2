export const dynamic = 'force-dynamic';

import { LegalLocalizationsEditor } from '@/components/admin/legal-localizations-editor';
import { listLegalLocalizationVersions } from '@/server/admin/localizations';

export default async function AdminLegalLocalizationsPage() {
  const versions = await listLegalLocalizationVersions();
  return (
    <section className="space-y-6">
      <div>
        <h1 className="font-display text-h3 font-bold">Юридические документы</h1>
      </div>
      <LegalLocalizationsEditor versions={versions} />
    </section>
  );
}
