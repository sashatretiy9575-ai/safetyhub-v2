import { requireCapability } from '@/server/auth/session';
import { AdminEditor } from '@/components/admin/admin-editor';

export default async function NewArticlePage() {
  await requireCapability('content.manage');
  return <AdminEditor />;
}
