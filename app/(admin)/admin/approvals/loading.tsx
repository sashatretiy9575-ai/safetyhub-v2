import { AdminListSkeleton } from '@/components/admin/admin-skeletons';

export default function ApprovalsLoading() {
  return <AdminListSkeleton label="Загружаем заявки" rows={5} filters={false} />;
}
