import { z } from 'zod';
import type { AppLocale } from '@/lib/supabase/types';
import type { ArticleBlock } from '@/lib/content/articles';
import type { ContentSource } from '@/lib/content/content-metadata';
import type { ContentSeo } from '@/lib/validation/content-seo';
import { articleBlocksSchema } from '@/lib/validation/article';
import { contentMetadataSchema } from '@/lib/content/content-metadata';
import { contentSeoSchema } from '@/lib/validation/content-seo';

export const ADMIN_CONTENT_LOCALES = [
  'ru',
  'kk',
  'en',
  'zh',
] as const satisfies readonly AppLocale[];

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
const uuidSchema = z.string().uuid();

function boundedJson(maxBytes: number) {
  return z.record(z.string(), z.unknown()).superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
      context.addIssue({ code: 'custom', message: 'payloadTooLarge' });
    }
  });
}

export const courseLocalizationDraftSchema = z
  .object({
    locale: appLocaleSchema.exclude(['ru']),
    expectedVersion: z.number().int().positive().nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000),
    content: boundedJson(512 * 1024),
    seo: contentSeoSchema,
    sources: contentMetadataSchema.shape.sources,
    presentationId: uuidSchema,
    complete: z.boolean().default(false),
  })
  .strict();

export const articleLocalizationDraftSchema = z
  .object({
    locale: appLocaleSchema.exclude(['ru']),
    expectedVersion: z.number().int().positive().nullable(),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2_000),
    blocks: articleBlocksSchema.max(100),
    seo: contentSeoSchema,
    sources: contentMetadataSchema.shape.sources,
    complete: z.boolean().default(false),
  })
  .strict();

export const localizedPublicationSchema = z
  .object({ expectedContentHash: z.string().regex(/^[0-9a-f]{64}$/u) })
  .strict();

export const legalLocalizationDraftSchema = z
  .object({
    documentType: z.enum(['privacy', 'terms']),
    version: z.string().trim().min(1).max(32),
    locale: appLocaleSchema,
    title: z.string().trim().min(3).max(200),
    body: boundedJson(256 * 1024),
    complete: z.boolean().default(false),
  })
  .strict();

export const legalVersionStageSchema = z
  .object({
    documentType: z.enum(['privacy', 'terms']),
    version: z.string().trim().min(1).max(32),
    bodyRevision: z.string().trim().min(3).max(160),
    effectiveAt: z
      .string()
      .max(40)
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u)
      .refine((value) => Number.isFinite(Date.parse(value)), 'effectiveAt'),
  })
  .strict();

export const legalPublicationSchema = z
  .object({
    documentType: z.enum(['privacy', 'terms']),
    version: z.string().trim().min(1).max(32),
  })
  .strict();

export type CourseLocalizationDraftInput = z.infer<typeof courseLocalizationDraftSchema>;
export type ArticleLocalizationDraftInput = z.infer<typeof articleLocalizationDraftSchema>;
export type LegalLocalizationDraftInput = z.infer<typeof legalLocalizationDraftSchema>;
export type LegalVersionStageInput = z.infer<typeof legalVersionStageSchema>;
