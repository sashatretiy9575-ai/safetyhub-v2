import { redirect } from 'next/navigation';

/**
 * The documents editor moved to «Документы» in the menu. Links kept from
 * before — a bookmark, the old buttons of the employee card — land on the
 * course they named, or on the list of courses.
 */
export default async function LegacyDocumentEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const course = typeof values.course === 'string' ? values.course.trim() : '';
  if (!course) redirect('/admin/documents');
  redirect(`/admin/documents/${encodeURIComponent(course)}`);
}
