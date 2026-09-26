export const dynamic = 'force-dynamic';

import { CommonDocumentForm } from '@/components/admin/documents/common-document-form';
import { requireCapability } from '@/server/auth/session';
import { readCertificateSettings } from '@/server/certificates/settings';

export const metadata = { title: 'Документы: общее' };

export default async function AdminCommonDocumentsPage() {
  await requireCapability('site.settings.manage');
  const settings = await readCertificateSettings();
  return <CommonDocumentForm key={settings.version} settings={settings} />;
}
