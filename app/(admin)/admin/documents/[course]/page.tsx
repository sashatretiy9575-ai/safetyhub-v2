export const dynamic = 'force-dynamic';

import { notFound, redirect } from 'next/navigation';
import { CourseDocumentForm } from '@/components/admin/documents/course-document-form';
import { requireCapability } from '@/server/auth/session';
import { readDocumentCourse } from '@/server/certificates/document-courses';
import { commonDocumentSettings, readCertificateSettings } from '@/server/certificates/settings';

export const metadata = { title: 'Документы курса' };

export default async function AdminCourseDocumentsPage({
  params,
}: {
  params: Promise<{ course: string }>;
}) {
  await requireCapability('site.settings.manage');
  const { course: key } = await params;
  const [settings, setup] = await Promise.all([
    readCertificateSettings(),
    readDocumentCourse(decodeURIComponent(key)),
  ]);
  if (!setup) notFound();
  // Older links name the course by its id; the address of the page is its slug.
  if (setup.slug !== decodeURIComponent(key)) {
    redirect(`/admin/documents/${encodeURIComponent(setup.slug)}`);
  }
  return (
    <div className="mx-auto max-w-7xl">
      <CourseDocumentForm
        key={setup.profiles.map((profile) => `${profile.id}:${profile.revision}`).join(',')}
        setup={setup}
        common={commonDocumentSettings(settings)}
      />
    </div>
  );
}
