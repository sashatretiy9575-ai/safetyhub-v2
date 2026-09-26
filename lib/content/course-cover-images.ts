import { DEFAULT_LOCALE, type AppLocale } from '../../i18n/config.ts';
import manifest from './course-cover-manifest.json' with { type: 'json' };

/**
 * Catalog cover for a course: the first page of the course's own presentation.
 *
 * The five launch courses used to carry hand-drawn illustrations that had
 * nothing to do with the material a learner then opened, while the two courses
 * of September already showed their own title slide. Every cover is now
 * exported from the presentation it belongs to, in the language it is read in
 * — `scripts/content/export-course-covers.mjs` writes both the files and the manifest
 * below, so a course with no exported cover falls back to its Russian one and
 * then to the picture an editor uploaded, instead of pointing at nothing.
 */
const COVERS: ReadonlySet<string> = new Set(manifest as readonly string[]);

const coverPath = (slug: string, locale: AppLocale) =>
  `/images/course-covers/${slug}-${locale}.webp`;

export function getCourseCoverImage(
  slug: string,
  locale: AppLocale = DEFAULT_LOCALE,
  uploadedImage?: string | null,
) {
  if (COVERS.has(`${slug}/${locale}`)) return coverPath(slug, locale);
  if (COVERS.has(`${slug}/${DEFAULT_LOCALE}`)) return coverPath(slug, DEFAULT_LOCALE);
  return uploadedImage ? uploadedImage : undefined;
}
