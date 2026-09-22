export const dynamic = 'force-dynamic';

import { notFound, redirect } from 'next/navigation';
import { CourseDocumentForm } from '@/components/admin/documents/course-document-form';
import { requireCapability } from '@/server/auth/session';
import { readDocumentCourse } from '@/server/certificates/document-courses';
import { commonDocumentSettings, readCertificateSettings } from '@/server/certificates/settings';

export default async function AdminCourseDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ course: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireCapability('site.settings.manage');
  const [{ course: key }, query] = await Promise.all([params, searchParams]);
  const [settings, setup] = await Promise.all([
    readCertificateSettings(),
    readDocumentCourse(decodeURIComponent(key)),
  ]);
  if (!setup) notFound();
  const tab = query.preview === 'booklet' ? 'certificate' : 'protocol';
  // Older links name the course by its id; the address of the page is its slug.
  if (setup.slug !== decodeURIComponent(key)) {
    redirect(
      `/admin/documents/${encodeURIComponent(setup.slug)}${tab === 'certificate' ? '?preview=booklet' : ''}`,
    );
  }
  return (
    <div className="mx-auto max-w-7xl">
      <CourseDocumentForm
        key={setup.profiles.map((profile) => `${profile.id}:${profile.revision}`).join(',')}
        setup={setup}
        common={commonDocumentSettings(settings)}
        initialTab={tab}
      />
    </div>
  );
}
