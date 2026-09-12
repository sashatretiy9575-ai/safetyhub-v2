import { AdminListSkeleton } from '@/components/admin/admin-skeletons';

export default function EmployeesLoading() {
  return <AdminListSkeleton label="Загружаем сотрудников" rows={8} summary />;
}
