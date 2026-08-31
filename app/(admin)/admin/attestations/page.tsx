import { redirect } from 'next/navigation';

export default async function LegacyAttestationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  const values = await searchParams;
  for (const [key, value] of Object.entries(values)) {
    for (const item of Array.isArray(value) ? value : value ? [value] : []) {
      params.append(key, item);
    }
  }
  redirect(`/admin/employees${params.size ? `?${params.toString()}` : ''}`);
}
