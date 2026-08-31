const COURSE_COVER_IMAGES: Readonly<Record<string, string>> = {
  plotnik: '/images/generated/topic-plotnik-v2.webp',
  armaturshchik: '/images/generated/topic-armaturshchik-v2.webp',
  'lesomontazhnye-raboty': '/images/generated/topic-lesomontazhnye-raboty-v2.webp',
  biot: '/images/generated/topic-occupational-health-v2.webp',
  'pozharnaya-bezopasnost': '/images/generated/topic-fire-safety-v2.webp',
};

export function getCourseCoverImage(slug: string) {
  return COURSE_COVER_IMAGES[slug];
}
