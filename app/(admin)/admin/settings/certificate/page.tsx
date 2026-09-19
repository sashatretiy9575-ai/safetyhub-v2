export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { ArrowLeft } from '@phosphor-icons/react/dist/ssr/ArrowLeft';
import { CertificateSettingsForm } from '@/components/admin/certificate-settings-form';
import { Button } from '@/components/ui/button';
import { readCertificateSettings } from '@/server/certificates/settings';
import { readDocumentEditor } from '@/server/certificates/document-editor';
import { readDocumentProfiles } from '@/server/certificates/document-profiles';

export default async function AdminCertificateSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const value = (key: string) => typeof params[key] === 'string' ? params[key] as string : undefined;
  const [settings, data, profiles] = await Promise.all([readCertificateSettings(), readDocumentEditor(value('organization'), value('course')), readDocumentProfiles()]);

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
        </div>
        <Button asChild size="icon" variant="ghost">
          <Link href="/admin/settings" aria-label="К настройкам"><ArrowLeft aria-hidden="true" /></Link>
        </Button>
      </div>

      <CertificateSettingsForm initialSettings={settings} initialData={data} profiles={profiles} initialSelection={{ organization: value('organization'), course: value('course'), user: value('user'), tab: value('tab') }} />
    </div>
  );
}
