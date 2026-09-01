import { notFound } from 'next/navigation';
import { getTestEditorSeed } from '@/features/admin/server';
import { getCourseEditorLocalizations } from '@/features/admin/localizations-server';
import { TestEditor } from '@/components/admin/test-editor';
import { CourseLocalizationsEditor } from '@/components/admin/course-localizations-editor';

export default async function EditCoursePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ publication?: string }>;
}) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const seed = await getTestEditorSeed(id);
  if (!seed) notFound();
  const localizations = await getCourseEditorLocalizations(id);
  return (
    <section className="space-y-6">
      <h1 className="font-display text-3xl font-bold">Новая редакция курса</h1>
      <TestEditor
        initial={seed}
        initialPublicationNotice={
          query.publication === 'incomplete' || query.publication === 'failed'
            ? query.publication
            : null
        }
      />
      <CourseLocalizationsEditor courseId={id} initial={localizations} />
    </section>
  );
}
