import * as z from 'zod/mini';
import { isSafeSourceUrl } from '../validation/source-url.ts';

export const CONTENT_METADATA_LIMITS = Object.freeze({
  jurisdictionMax: 120,
  sourceCountMax: 10,
  sourceTitleMax: 240,
  sourceUrlMax: 2_048,
});

const contentDateSchema = z.string().check(
  z.trim(),
  z.maxLength(40),
  z.refine(
    (value) =>
      value === '' ||
      (/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value))),
    'Неверная дата',
  ),
);

export const contentSourceSchema = z.object({
  title: z.string().check(z.trim(), z.maxLength(CONTENT_METADATA_LIMITS.sourceTitleMax)),
  url: z.string().check(z.trim(), z.maxLength(CONTENT_METADATA_LIMITS.sourceUrlMax)),
});

export const contentMetadataDraftSchema = z.object({
  jurisdiction: z._default(
    z.string().check(z.trim(), z.maxLength(CONTENT_METADATA_LIMITS.jurisdictionMax)),
    '',
  ),
  effectiveDate: z._default(contentDateSchema, ''),
  sources: z._default(
    z.array(contentSourceSchema).check(z.maxLength(CONTENT_METADATA_LIMITS.sourceCountMax)),
    [],
  ),
});

export const contentMetadataSchema = contentMetadataDraftSchema.check(
  z.superRefine((value, context) => {
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
      if (!isSafeSourceUrl(source.url)) {
        context.addIssue({
          code: 'custom',
          path: ['sources', index, 'url'],
          message: 'Используйте HTTPS-ссылку',
        });
      }
    });
  }),
);

export type ContentSource = z.infer<typeof contentSourceSchema>;
export type ContentMetadata = z.infer<typeof contentMetadataSchema>;

/**
 * Reading is deliberately lenient per element. The previous version parsed the
 * whole object and, on any failure, returned an empty one — so a single source
 * with a typo erased the jurisdiction, the effective date and every other
 * reference from the published page, with nothing shown to the reader and
 * nothing logged. Unsafe links are dropped; everything valid survives.
 */
export function coerceContentMetadata(value: unknown): ContentMetadata {
  const parsed = contentMetadataDraftSchema.safeParse(value);
  if (!parsed.success) {
    return { jurisdiction: '', effectiveDate: '', sources: [] };
  }
  return {
    ...parsed.data,
    sources: parsed.data.sources.filter(
      (source) => source.title.length > 0 && isSafeSourceUrl(source.url),
    ),
  };
}

/**
 * The publication gate. Draft schemas stay permissive so an operator can save a
 * half-typed reference, but a revision that goes live must carry links this
 * product is willing to put in front of a reader.
 */
export const publishableContentMetadataSchema = contentMetadataSchema;

export function toContentDateInput(value: string) {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? '';
}
