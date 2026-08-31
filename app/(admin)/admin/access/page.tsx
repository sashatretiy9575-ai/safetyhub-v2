import { redirect } from 'next/navigation';

export default function RemovedAccessPage() {
  redirect('/admin/settings');
}
