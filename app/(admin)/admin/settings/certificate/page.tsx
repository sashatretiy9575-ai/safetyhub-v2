export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { CertificateSettingsForm } from '@/components/admin/certificate-settings-form';
import { Button } from '@/components/ui/button';
import { readCertificateSettings } from '@/features/certificates/settings';

export default async function AdminCertificateSettingsPage() {
  const settings = await readCertificateSettings();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Удостоверение</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Настраивается один раз. Каждое удостоверение (корочка из двух сторон) и каждый протокол
            комиссии собираются с этими реквизитами, печатью и подписями.
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link href="/admin/settings">К настройкам</Link>
        </Button>
      </div>

      <CertificateSettingsForm initialSettings={settings} />
    </div>
  );
}
