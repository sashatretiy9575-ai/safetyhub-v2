import { redirect } from 'next/navigation';

export default function LegacyAdminResultsPage() {
  redirect('/admin/employees');
}
