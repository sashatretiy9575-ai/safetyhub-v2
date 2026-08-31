import { notFound } from 'next/navigation';
import { getTestEditorSeed } from '@/features/admin/server';
import { TestEditor } from '@/components/admin/test-editor';

export default async function EditCoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const seed = await getTestEditorSeed(id);
  if (!seed) notFound();
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl font-bold">Новая редакция курса</h1>
      <TestEditor initial={seed} />
    </section>
  );
}
