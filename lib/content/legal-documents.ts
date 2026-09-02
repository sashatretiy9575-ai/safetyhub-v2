import 'server-only';

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { isAppLocale, type AppLocale } from '@/i18n/config';
import {
  LEGAL_DOCUMENT_VERSIONS,
  resolveLegalDocumentVersion,
  type LegalDocumentType,
} from '@/lib/legal';

const legalSectionSchema = z
  .object({
    id: z.string().min(1).max(160),
    heading: z.string().min(1).max(300),
    paragraphs: z.array(z.string().min(1).max(12_000)).max(30),
    items: z.array(z.string().min(1).max(6_000)).max(50),
    links: z
      .array(
        z.object({
          label: z.string().min(1).max(300),
          url: z
            .string()
            .min(1)
            .max(2_000)
            .refine(
              (url) =>
                url.startsWith('https://') ||
                (/^\/(?!\/)/u.test(url) && !url.includes('\\')) ||
                /^#[a-z][a-z0-9-]*$/iu.test(url),
              'safeLegalLink',
            ),
        }),
      )
      .max(20)
      .optional()
      .default([]),
  })
  .strict();

const legalBodySchema = z
  .object({
    sections: z.array(legalSectionSchema).min(1).max(50),
  })
  .passthrough();

const localizedLegalDocumentSchema = z
  .object({
    type: z.enum(['privacy', 'terms']),
    version: z.string().min(1).max(32),
    locale: z.enum(['ru', 'kk', 'en', 'zh']),
    title: z.string().min(3).max(200),
    body: legalBodySchema,
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict();

const localLegalDocumentSourceSchema = z
  .object({
    documentType: z.enum(['privacy', 'terms']),
    version: z.string().min(1).max(32),
    locale: z.enum(['ru', 'kk', 'en', 'zh']),
    title: z.string().min(3).max(200),
    body: z.unknown(),
    bodySourceSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .passthrough();

const snapshotLocalizationSchema = z
  .object({
    locale: z.enum(['ru', 'kk', 'en', 'zh']),
    title: z.string().min(3).max(200),
    body: z.unknown(),
    bodyHash: z.string().regex(/^[0-9a-f]{64}$/u),
    status: z.literal('published'),
  })
  .passthrough();

const snapshotLegalVersionSchema = z
  .object({
    documentType: z.enum(['privacy', 'terms']),
    version: z.string().min(1).max(32),
    effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
    localizations: z.array(snapshotLocalizationSchema),
  })
  .passthrough();

const snapshotManifestSchema = z
  .object({
    legalVersions: z.array(snapshotLegalVersionSchema),
  })
  .passthrough();

export type LocalizedLegalDocument = z.infer<typeof localizedLegalDocumentSchema>;

const legalContentDirectory = path.join(process.cwd(), 'content', 'legal');
const localizationSnapshotPath = path.join(
  process.cwd(),
  'content',
  'snapshots',
  'localizations',
  'manifest.json',
);

const documentCache = new Map<string, LocalizedLegalDocument | null>();
let snapshotManifest: z.infer<typeof snapshotManifestSchema> | null | undefined;

function cacheKey(type: LegalDocumentType, version: string, locale: AppLocale) {
  return `${type}:${version}:${locale}`;
}

function parseLocalizedDocument(value: unknown): LocalizedLegalDocument | null {
  const parsed = localizedLegalDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readJson(pathname: string): unknown | null {
  try {
    return JSON.parse(readFileSync(pathname, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function readLocalDocument(
  type: LegalDocumentType,
  version: string,
  locale: AppLocale,
): LocalizedLegalDocument | null {
  const pathname = path.join(legalContentDirectory, type, `${version}.${locale}.json`);
  if (!existsSync(pathname)) return null;

  const parsed = localLegalDocumentSourceSchema.safeParse(readJson(pathname));
  if (!parsed.success) return null;
  if (parsed.data.documentType !== type || parsed.data.version !== version || parsed.data.locale !== locale) {
    return null;
  }

  return parseLocalizedDocument({
    type: parsed.data.documentType,
    version: parsed.data.version,
    locale: parsed.data.locale,
    title: parsed.data.title,
    body: parsed.data.body,
    bodyHash: parsed.data.bodySourceSha256,
    effectiveAt: parsed.data.effectiveAt,
  });
}

function readSnapshotManifest(): z.infer<typeof snapshotManifestSchema> | null {
  if (snapshotManifest !== undefined) return snapshotManifest;
  snapshotManifest = snapshotManifestSchema.safeParse(readJson(localizationSnapshotPath)).data ?? null;
  return snapshotManifest;
}

function readSnapshotDocument(
  type: LegalDocumentType,
  version: string,
  locale: AppLocale,
): LocalizedLegalDocument | null {
  const legalVersion = readSnapshotManifest()?.legalVersions.find(
    (candidate) => candidate.documentType === type && candidate.version === version,
  );
  const localization = legalVersion?.localizations.find((candidate) => candidate.locale === locale);
  if (!legalVersion || !localization) return null;

  return parseLocalizedDocument({
    type,
    version,
    locale,
    title: localization.title,
    body: localization.body,
    bodyHash: localization.bodyHash,
    effectiveAt: legalVersion.effectiveAt,
  });
}

/**
 * Reads only the committed immutable content receipt. Public legal rendering
 * deliberately never queries Supabase or request cookies, so it can be built
 * once and served from the CDN without depending on a viewer's session.
 */
export function getStaticLegalDocument(
  type: LegalDocumentType,
  version: string,
  locale: AppLocale,
): LocalizedLegalDocument | null {
  if (!isAppLocale(locale) || !resolveLegalDocumentVersion(type, version)) return null;

  const key = cacheKey(type, version, locale);
  if (documentCache.has(key)) return documentCache.get(key) ?? null;

  const document = readLocalDocument(type, version, locale) ?? readSnapshotDocument(type, version, locale);
  documentCache.set(key, document);
  return document;
}

/**
 * The first Russian copies predate structured localization receipts. They are
 * preserved as immutable versioned React renderers until a structured receipt
 * is published; no other locale may fall back to a Russian document.
 */
export function hasLegacyRussianLegalRenderer(type: LegalDocumentType, version: string) {
  return (
    (type === 'privacy' && (version === '1.1' || version === '1.2')) ||
    (type === 'terms' && (version === '2.1' || version === '2.2'))
  );
}

/**
 * Generates only addresses whose immutable localized document (or explicit
 * Russian legacy renderer) exists at build time. `dynamicParams = false` then
 * makes unknown versions a static 404 instead of a cookie-bound fallback.
 */
export function staticLegalVersions(type: LegalDocumentType, locale: AppLocale): string[] {
  return LEGAL_DOCUMENT_VERSIONS[type]
    .filter(
      (policy) =>
        getStaticLegalDocument(type, policy.version, locale) !== null ||
        (locale === 'ru' && hasLegacyRussianLegalRenderer(type, policy.version)),
    )
    .map((policy) => policy.version);
}
