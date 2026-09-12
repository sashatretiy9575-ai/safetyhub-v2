import { AdminListSkeleton } from '@/components/admin/admin-skeletons';

export default function AuditLoading() {
  return <AdminListSkeleton label="Загружаем историю действий" rows={10} />;
}
