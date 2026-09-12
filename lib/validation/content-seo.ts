import * as z from 'zod/mini';
import { articleCoverImageSchema } from './article.ts';

export const CONTENT_SEO_LIMITS = Object.freeze({
  titleMax: 70,
  descriptionMax: 200,
});

const seoTitleSchema = z
  .string()
  .check(z.trim(), z.minLength(3), z.maxLength(CONTENT_SEO_LIMITS.titleMax));
const seoDescriptionSchema = z
  .string()
  .check(z.trim(), z.minLength(40), z.maxLength(CONTENT_SEO_LIMITS.descriptionMax));

export const contentSeoSchema = z.strictObject({
  title: seoTitleSchema,
  description: seoDescriptionSchema,
  ogTitle: seoTitleSchema,
  ogDescription: seoDescriptionSchema,
  ogImage: articleCoverImageSchema,
  indexable: z.boolean(),
});

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
