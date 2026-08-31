import { notFound } from 'next/navigation';
import { getTestEditorPayload } from '@/features/admin/server';
import type { TestEditorPayload } from '@/features/admin/types';
import { TestEditor } from '@/components/admin/test-editor';

export default async function EditCoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const payload = await getTestEditorPayload(id);
  if (!payload) notFound();
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl font-bold">Редактирование курса</h1>
      <TestEditor initial={payload as unknown as TestEditorPayload} />
    </section>
  );
}
