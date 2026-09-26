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

/** A tile of the grid: two a row on a phone, more as the screen widens. */
const TILE =
  'group flex min-h-24 min-w-0 flex-col justify-between gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-muted)]';

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
    lead.family === 'electrical'
      ? 'удостоверение ЭБ'
      : lead.booklet
        ? 'корочка своя'
        : 'корочка общая',
  ]
    .filter(Boolean)
    .join(' · ');
}

export const metadata = { title: 'Документы' };

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
    <div className="mx-auto max-w-5xl space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Документы</h1>
      <nav
        aria-label="Документы курсов"
        className="grid min-w-0 grid-cols-2 gap-2 sm:gap-3 md:grid-cols-3 lg:grid-cols-4"
      >
        <Link href="/admin/documents/common" className={`${TILE} col-span-full`}>
          <span className="flex min-w-0 items-center justify-between gap-2">
            <span className="text-sm font-semibold">Общее</span>
            <CaretRight
              aria-hidden="true"
              size={16}
              className="shrink-0 text-[var(--color-text-subtle)] transition-transform group-hover:translate-x-0.5"
            />
          </span>
          <span className="min-w-0">
            <span className="block text-xs break-words text-[var(--color-text-muted)]">
              {common.organizationName}
            </span>
            {missing.length ? (
              <span className="block text-xs break-words text-[var(--color-danger)]">
                {missing.join(', ')}
              </span>
            ) : null}
          </span>
        </Link>
        {courses.map((course) => {
          const summary = courseSummary(course);
          return (
            <Link
              key={course.courseId}
              href={`/admin/documents/${encodeURIComponent(course.slug)}`}
              className={TILE}
            >
              <span className="text-sm leading-snug font-semibold [overflow-wrap:anywhere]">
                {course.title}
              </span>
              <span
                className={`text-xs [overflow-wrap:anywhere] ${summary ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-danger)]'}`}
              >
                {summary ?? 'не настроен'}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
