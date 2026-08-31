import { z } from 'zod';

export const CONTENT_METADATA_LIMITS = Object.freeze({
  jurisdictionMax: 120,
  sourceCountMax: 10,
  sourceTitleMax: 240,
  sourceUrlMax: 2_048,
});

const contentDateSchema = z
  .string()
  .trim()
  .max(40)
  .refine(
    (value) =>
      value === '' ||
      (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value))),
    'Неверная дата',
  );

export const contentSourceSchema = z.object({
  title: z.string().trim().max(CONTENT_METADATA_LIMITS.sourceTitleMax),
  url: z.string().trim().max(CONTENT_METADATA_LIMITS.sourceUrlMax),
});

export const contentMetadataDraftSchema = z.object({
  jurisdiction: z
    .string()
    .trim()
    .max(CONTENT_METADATA_LIMITS.jurisdictionMax)
    .default('')
    .transform((value) => value ?? ''),
  effectiveDate: contentDateSchema.default('').transform((value) => value ?? ''),
  sources: z.array(contentSourceSchema).max(CONTENT_METADATA_LIMITS.sourceCountMax).default([]),
});

export const contentMetadataSchema = contentMetadataDraftSchema.superRefine((value, context) => {
  value.sources.forEach((source, index) => {
    const hasTitle = source.title.length > 0;
    const hasUrl = source.url.length > 0;
    if (!hasTitle && !hasUrl) return;
    if (!hasTitle) {
      context.addIssue({
        code: 'custom',
        path: ['sources', index, 'title'],
        message: 'Укажите название источника',
      });
    }
    if (!/^https:\/\/[^\s]+$/i.test(source.url)) {
      context.addIssue({
        code: 'custom',
        path: ['sources', index, 'url'],
        message: 'Используйте HTTPS-ссылку',
      });
    }
  });
});

export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;

export function coerceContentMetadata(value: unknown): ContentMetadata {
  const parsed = contentMetadataSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : {
        jurisdiction: '',
        effectiveDate: '',
        sources: [],
      };
}

export function toContentDateInput(value: string) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? '';
}
