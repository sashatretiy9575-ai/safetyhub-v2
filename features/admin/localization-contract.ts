import * as z from 'zod/mini';
import { APP_LOCALES, type AppLocale } from '@/i18n/config';
import type { ArticleBlock } from '@/lib/content/articles';
import type { ContentSource } from '@/lib/content/content-metadata';
import type { ContentSeo } from '@/lib/validation/content-seo';
import { articleBlocksWriteSchema } from '@/lib/validation/article';
import { contentMetadataSchema } from '@/lib/content/content-metadata';
import { contentSeoSchema } from '@/lib/validation/content-seo';

/** The content locales are the application locales; there is only one list. */
export const ADMIN_CONTENT_LOCALES = APP_LOCALES;

export const ADMIN_LOCALE_LABELS: Record<AppLocale, string> = {
  ru: 'Русский',
  kk: 'Қазақша',
  en: 'English',
  zh: '简体中文',
};

export const ADMIN_LOCALIZATION_STATUS_LABELS = {
  missing: 'Не заполнено',
  draft: 'Черновик',
  complete: 'Готово',
  published: 'Опубликовано',
} as const;

export type AdminLocalizationStatus = keyof typeof ADMIN_LOCALIZATION_STATUS_LABELS;

export type AdminLocalizedPresentation = {
  id: string;
  locale: AppLocale;
  pageCount: number;
  sha256: string;
  byteSize: number;
  status: 'staging' | 'validating' | 'ready' | 'rejected' | 'retired';
};

export type CourseLocalizationEditorItem = {
  locale: AppLocale;
  status: AdminLocalizationStatus;
  title: string;
  description: string;
  content: Record<string, unknown>;
  assessment: { variantCount: number; questionCounts: number[] } | null;
  seo: ContentSeo;
  sources: ContentSource[];
  contentHash: string | null;
  reviewedContentHash: string | null;
  assessmentImported: boolean;
  draftVersion: number | null;
  presentation: AdminLocalizedPresentation | null;
};

export type ArticleLocalizationEditorItem = {
  locale: AppLocale;
  status: AdminLocalizationStatus;
  title: string;
  description: string;
  blocks: ArticleBlock[];
  seo: ContentSeo;
  sources: ContentSource[];
  contentHash: string | null;
  reviewedContentHash: string | null;
  draftVersion: number | null;
};

export type LegalLocalizationEditorItem = {
  locale: AppLocale;
  status: AdminLocalizationStatus;
  title: string;
  body: Record<string, unknown>;
  bodyHash: string | null;
  immutable: boolean;
};

export type LegalLocalizationVersion = {
  documentType: 'privacy' | 'terms';
  version: string;
  bodyRevision: string;
  effectiveAt: string;
  current: boolean;
  localizations: LegalLocalizationEditorItem[];
};

export const appLocaleSchema = z.enum(ADMIN_CONTENT_LOCALES);
/** Russian is the source language; a translation draft is never written for it. */
export const translatedLocaleSchema = z.enum(
  ADMIN_CONTENT_LOCALES.filter((locale): locale is Exclude<AppLocale, 'ru'> => locale !== 'ru'),
);
const uuidSchema = z.uuid();
const documentTypeSchema = z.enum(['privacy', 'terms']);
const shortVersionSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(32));
const localizedTitleSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(200));
const localizedDescriptionSchema = z.string().check(z.trim(), z.maxLength(2_000));
const expectedVersionSchema = z.nullable(z.int().check(z.positive()));

function boundedJson(maxBytes: number) {
  return z.record(z.string(), z.unknown()).check(
    z.superRefine((value, context) => {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
        context.addIssue({ code: 'custom', message: 'payloadTooLarge' });
      }
    }),
  );
}

export const courseLocalizationDraftSchema = z.strictObject({
  locale: translatedLocaleSchema,
  expectedVersion: expectedVersionSchema,
  title: localizedTitleSchema,
  description: localizedDescriptionSchema,
  content: boundedJson(512 * 1024),
  seo: contentSeoSchema,
  sources: contentMetadataSchema.shape.sources,
  presentationId: uuidSchema,
  complete: z._default(z.boolean(), false),
});

export const articleLocalizationDraftSchema = z.strictObject({
  locale: translatedLocaleSchema,
  expectedVersion: expectedVersionSchema,
  title: localizedTitleSchema,
  description: localizedDescriptionSchema,
  blocks: articleBlocksWriteSchema.check(z.maxLength(100)),
  seo: contentSeoSchema,
  sources: contentMetadataSchema.shape.sources,
  complete: z._default(z.boolean(), false),
});

export const localizedPublicationSchema = z.strictObject({
  expectedContentHash: z.string().check(z.regex(/^[0-9a-f]{64}$/u)),
});

export const legalLocalizationDraftSchema = z.strictObject({
  documentType: documentTypeSchema,
  version: shortVersionSchema,
  locale: appLocaleSchema,
  title: z.string().check(z.trim(), z.minLength(3), z.maxLength(200)),
  body: boundedJson(256 * 1024),
  complete: z._default(z.boolean(), false),
});

export const legalVersionStageSchema = z.strictObject({
  documentType: documentTypeSchema,
  version: shortVersionSchema,
  bodyRevision: z.string().check(z.trim(), z.minLength(3), z.maxLength(160)),
  effectiveAt: z
    .string()
    .check(
      z.maxLength(40),
      z.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u),
      z.refine((value) => Number.isFinite(Date.parse(value)), 'effectiveAt'),
    ),
});

export const legalBundlePublicationSchema = z.strictObject({
  privacyVersion: shortVersionSchema,
  termsVersion: shortVersionSchema,
});

export type CourseLocalizationDraftInput = z.infer<typeof courseLocalizationDraftSchema>;
export type ArticleLocalizationDraftInput = z.infer<typeof articleLocalizationDraftSchema>;
export type LegalLocalizationDraftInput = z.infer<typeof legalLocalizationDraftSchema>;
export type LegalVersionStageInput = z.infer<typeof legalVersionStageSchema>;
export type LegalBundlePublicationInput = z.infer<typeof legalBundlePublicationSchema>;
