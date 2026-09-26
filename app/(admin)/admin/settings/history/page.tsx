import AuditPage from '../../audit/page';
import type { RawAdminSearchParams } from '@/server/admin/data';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'История действий' };

/**
 * The historical URL of the administrator log. It renders the same page, but
 * the links that page builds have to keep pointing here — before this they all
 * named the other path, so turning a page moved the reader across URLs.
 */
export default function AdminHistoryPage({
  searchParams,
}: {
  searchParams: Promise<RawAdminSearchParams>;
}) {
  return <AuditPage searchParams={searchParams} basePath="/admin/settings/history" />;
}
