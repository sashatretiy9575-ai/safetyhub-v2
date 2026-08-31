import { z } from 'zod';
import { articleCoverImageSchema } from './article.ts';

export const CONTENT_SEO_LIMITS = Object.freeze({
  titleMax: 70,
  descriptionMax: 200,
});

export const contentSeoSchema = z
  .object({
    title: z.string().trim().min(3).max(CONTENT_SEO_LIMITS.titleMax),
    description: z.string().trim().min(40).max(CONTENT_SEO_LIMITS.descriptionMax),
    ogTitle: z.string().trim().min(3).max(CONTENT_SEO_LIMITS.titleMax),
    ogDescription: z.string().trim().min(40).max(CONTENT_SEO_LIMITS.descriptionMax),
    ogImage: articleCoverImageSchema,
    indexable: z.boolean(),
  })
  .strict();

export type ContentSeo = z.infer<typeof contentSeoSchema>;

export function defaultContentSeo(title = '', description = '', ogImage = ''): ContentSeo {
  const candidateTitle = title.trim();
  const safeTitle = candidateTitle.length >= 3 ? candidateTitle : 'Материал SafetyHub';
  const candidateDescription = description.trim();
  const safeDescription =
    candidateDescription.length >= 40
      ? candidateDescription
      : `${candidateDescription ? `${candidateDescription}. ` : ''}Практический материал SafetyHub по безопасности труда и промышленной безопасности.`;
  return {
    title: safeTitle.slice(0, CONTENT_SEO_LIMITS.titleMax),
    description: safeDescription.slice(0, CONTENT_SEO_LIMITS.descriptionMax),
    ogTitle: safeTitle.slice(0, CONTENT_SEO_LIMITS.titleMax),
    ogDescription: safeDescription.slice(0, CONTENT_SEO_LIMITS.descriptionMax),
    ogImage,
    indexable: true,
  };
}
