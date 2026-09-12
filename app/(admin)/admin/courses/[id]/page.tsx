import { notFound } from 'next/navigation';
import { getTestEditorSeed } from '@/server/admin/management';
import { getCourseEditorLocalizations } from '@/server/admin/localizations';
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
  // The editor seed and the translations are independent reads; a missing
  // course still answers 404 even if the translation read fails first.
  const [seedResult, localizationsResult] = await Promise.allSettled([
    getTestEditorSeed(id),
    getCourseEditorLocalizations(id),
  ]);
  if (seedResult.status === 'rejected') throw seedResult.reason;
  const seed = seedResult.value;
  if (!seed) notFound();
  if (localizationsResult.status === 'rejected') throw localizationsResult.reason;
  const localizations = localizationsResult.value;
  return (
    <section className="space-y-6">
      <h1 className="font-display text-h3 font-bold">Новая редакция курса</h1>
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
