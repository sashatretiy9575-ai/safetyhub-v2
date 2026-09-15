export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { CertificateSettingsForm } from '@/components/admin/certificate-settings-form';
import { Button } from '@/components/ui/button';
import { readCertificateSettings } from '@/server/certificates/settings';
import { readDocumentEditor } from '@/server/certificates/document-editor';

export default async function AdminCertificateSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [settings, data, params] = await Promise.all([readCertificateSettings(), readDocumentEditor(), searchParams]);
  const value = (key: string) => typeof params[key] === 'string' ? params[key] as string : undefined;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/settings">К настройкам</Link>
        </Button>
      </div>

      <CertificateSettingsForm initialSettings={settings} initialData={data} initialSelection={{ organization: value('organization'), course: value('course'), user: value('user'), tab: value('tab') }} />
    </div>
  );
}
