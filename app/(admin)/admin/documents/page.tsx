export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { CaretRight } from '@phosphor-icons/react/dist/ssr/CaretRight';
import {
  AUDIENCE_LABELS,
  DOCUMENT_FAMILY_LABELS,
  type CourseDocumentSetup,
} from '@/lib/pdf/document-course';
import { completeDocumentProfile } from '@/lib/pdf/document-family-defaults';
import { requireCapability } from '@/server/auth/session';
import { readDocumentCourses } from '@/server/certificates/document-courses';
import { commonDocumentSettings, readCertificateSettings } from '@/server/certificates/settings';

const ROW =
  'group flex min-h-14 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-surface-muted)]';

/** «БиОТ · ИТР 40 ч, рабочие 10 ч · корочка своя». */
function courseSummary(course: CourseDocumentSetup) {
  const [lead] = course.profiles;
  if (!lead) return null;
  const split = !course.profiles.some((profile) => profile.audience === 'all');
  const hours = course.profiles
    .map((profile) => {
      const printed = completeDocumentProfile(profile).hours;
      if (!printed) return null;
      const word = split ? AUDIENCE_LABELS[profile.audience] : '';
      return `${word ? (profile.audience === 'itr' ? word : word.toLowerCase()) + ' ' : ''}${printed} ч`;
    })
    .filter(Boolean);
  return [
    DOCUMENT_FAMILY_LABELS[lead.family],
    hours.length ? hours.join(', ') : split ? 'ИТР и рабочие' : null,
    lead.booklet ? 'корочка своя' : 'корочка общая',
  ]
    .filter(Boolean)
    .join(' · ');
}

export default async function AdminDocumentsPage() {
  await requireCapability('site.settings.manage');
  const [settings, courses] = await Promise.all([readCertificateSettings(), readDocumentCourses()]);
  const common = commonDocumentSettings(settings);
  const missing = [
    common.documentCommission.stampAssetId ? null : 'нет печати',
    ...common.documentCommission.signers
      .filter((signer) => !signer.assetId)
      .map((signer) => `нет подписи: ${signer.name}`),
    common.documentDefaults.insertWidthCm && common.documentDefaults.insertHeightCm
      ? null
      : 'нет размера корочки',
  ].filter(Boolean);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
      <nav
        aria-label="Документы курсов"
        className="divide-y divide-[var(--color-border)] overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <Link href="/admin/documents/common" className={ROW}>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Общее</span>
            <span className="block text-xs break-words text-[var(--color-text-muted)]">
              {common.organizationName}
            </span>
            {missing.length ? (
              <span className="block text-xs break-words text-[var(--color-danger)]">
                {missing.join(', ')}
              </span>
            ) : null}
          </span>
          <CaretRight
            size={16}
            className="shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
        {courses.map((course) => {
          const summary = courseSummary(course);
          return (
            <Link
              key={course.courseId}
              href={`/admin/documents/${encodeURIComponent(course.slug)}`}
              className={ROW}
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold break-words">{course.title}</span>
                <span
                  className={`block text-xs break-words ${summary ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}`}
                >
                  {summary ?? 'не настроен'}
                </span>
              </span>
              <CaretRight
                size={16}
                className="shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
              />
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
