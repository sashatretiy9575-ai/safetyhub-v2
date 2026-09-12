const COURSE_COVER_IMAGES: Readonly<Record<string, string>> = {
  plotnik: '/images/generated/topic-plotnik-v2.webp',
  armaturshchik: '/images/generated/topic-armaturshchik-v2.webp',
  'lesomontazhnye-raboty': '/images/generated/topic-lesomontazhnye-raboty-v2.webp',
  biot: '/images/generated/topic-occupational-health-v2.webp',
  'pozharnaya-bezopasnost': '/images/generated/topic-fire-safety-v2.webp',
};

/**
 * Catalog cover for a course.
 *
 * The five launch courses ship a hand-made cover in the bundle. Every other
 * course has no cover of its own in the schema, so the picture an editor
 * actually uploads in the course editor — the SEO/Open Graph image — is used
 * instead. Without this fallback an uploaded image was stored, previewed and
 * then silently ignored by the catalog.
 */
export function getCourseCoverImage(slug: string, uploadedImage?: string | null) {
  return COURSE_COVER_IMAGES[slug] ?? (uploadedImage ? uploadedImage : undefined);
}
