import 'server-only';

import { revalidatePath, revalidateTag } from 'next/cache';
import { z } from 'zod';
import { requireCapability } from '@/features/auth/server';
import {
  ADMIN_CONTENT_LOCALES,
  type AdminLocalizedPresentation,
  type AdminLocalizationStatus,
  type ArticleLocalizationDraftInput,
  type ArticleLocalizationEditorItem,
  type CourseLocalizationDraftInput,
  type CourseLocalizationEditorItem,
  type LegalLocalizationDraftInput,
  type LegalLocalizationVersion,
  type LegalVersionStageInput,
} from '@/features/admin/localization-contract';
import { CONTENT_CACHE_TAG, TOPICS_CACHE_TAG } from '@/lib/content/cache-policy';
import { contentMetadataSchema } from '@/lib/content/content-metadata';
import { defaultContentSeo, contentSeoSchema } from '@/lib/validation/content-seo';
import { articleBlocksSchema } from '@/lib/validation/article';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { unwrapRpcMutationResponse } from '@/lib/supabase/rpc-mutation-result';
import type { AppLocale, Json } from '@/lib/supabase/types';

type RpcError = { code?: string; message: string };
type UntypedRpcClient = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: RpcError | null }>;
};

type RawRecord = Record<string, unknown>;

const uuidSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const presentationStatusSchema = z.enum(['staging', 'validating', 'ready', 'rejected', 'retired']);
const localizationStatusSchema = z.enum(['missing', 'draft', 'complete']);

const editorPresentationSchema = z
  .object({
    id: uuidSchema,
    locale: z.enum(ADMIN_CONTENT_LOCALES),
    pageCount: z.coerce.number().int().min(1).max(200),
    sha256: hashSchema,
    byteSize: z.coerce
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    status: presentationStatusSchema,
  })
  .strict();

const courseEditorRowSchema = z
  .object({
    locale: z.enum(ADMIN_CONTENT_LOCALES),
    status: localizationStatusSchema,
    title: z.string().max(200),
    description: z.string().max(2_000),
    content: z.record(z.string(), z.unknown()),
    assessment: z
      .object({
        variantCount: z.coerce.number().int().min(0).max(3),
        questionCounts: z.array(z.coerce.number().int().min(0).max(10)).max(3),
      })
      .strict()
      .nullable(),
    seo: z.record(z.string(), z.unknown()),
    sources: z.array(z.unknown()),
    contentHash: hashSchema.nullable(),
    reviewedContentHash: hashSchema.nullable(),
    translationQa: z.record(z.string(), z.unknown()),
    draftVersion: z.coerce.number().int().positive().nullable(),
    presentation: editorPresentationSchema.nullable(),
  })
  .strict();

const articleEditorRowSchema = z
  .object({
    locale: z.enum(ADMIN_CONTENT_LOCALES),
    status: localizationStatusSchema,
    title: z.string().max(200),
    description: z.string().max(2_000),
    blocks: z.array(z.unknown()),
    seo: z.record(z.string(), z.unknown()),
    sources: z.array(z.unknown()),
    contentHash: hashSchema.nullable(),
    reviewedContentHash: hashSchema.nullable(),
    translationQa: z.record(z.string(), z.unknown()),
    draftVersion: z.coerce.number().int().positive().nullable(),
  })
  .strict();

const editorEnvelopeSchema = <T extends z.ZodTypeAny>(row: T, identityKey: string) =>
  z
    .object({
      [identityKey]: uuidSchema,
      localizations: z.array(row).length(4),
    })
    .strict();

const mutationResultSchema = z
  .object({
    locale: z.enum(ADMIN_CONTENT_LOCALES),
    status: localizationStatusSchema,
    draftVersion: z.coerce.number().int().positive(),
    contentHash: hashSchema,
  })
  .passthrough();

function untyped(client: unknown) {
  return client as UntypedRpcClient;
}

async function authenticatedRpc(name: string, args: Record<string, unknown>) {
  return unwrapRpcMutationResponse(await untyped(await createClient()).rpc(name, args));
}

function normalizedSeo(value: unknown, title: string, description: string) {
  const parsed = contentSeoSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultContentSeo(title, description);
}

function normalizedSources(value: unknown) {
  const parsed = contentMetadataSchema.shape.sources.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function publishedStatus(
  draftStatus: 'missing' | 'draft' | 'complete',
  draftHash: string | null,
  publishedHash: string | undefined,
): AdminLocalizationStatus {
  return draftStatus === 'complete' && draftHash && draftHash === publishedHash
    ? 'published'
    : draftStatus;
}

function invalidateLocalizedContent(kind: 'course' | 'article', slug: string | null) {
  revalidateTag(CONTENT_CACHE_TAG, { expire: 0 });
  if (kind === 'course') revalidateTag(TOPICS_CACHE_TAG, { expire: 0 });
  for (const locale of ADMIN_CONTENT_LOCALES) {
    const prefix = locale === 'ru' ? '' : `/${locale}`;
    revalidatePath(`${prefix}/`);
    revalidatePath(`${prefix}/${kind === 'course' ? 'topics' : 'blog'}`);
    if (slug) revalidatePath(`${prefix}/${kind === 'course' ? 'topics' : 'blog'}/${slug}`);
  }
  revalidatePath('/sitemap.xml');
  revalidatePath('/admin');
}

export async function getCourseEditorLocalizations(
  courseId: string,
): Promise<CourseLocalizationEditorItem[]> {
  const actor = await requireCapability('test.manage');
  const payload = editorEnvelopeSchema(courseEditorRowSchema, 'courseId').parse(
    await authenticatedRpc('get_course_editor_localizations', {
      p_actor_id: actor.user.id,
      p_test_id: courseId,
    }),
  ) as { courseId: string; localizations: z.infer<typeof courseEditorRowSchema>[] };

  const admin = createAdminClient();
  const current = await admin
    .from('tests')
    .select('current_revision_id')
    .eq('id', courseId)
    .maybeSingle();
  if (current.error) throw current.error;
  const published = current.data?.current_revision_id
    ? await admin
        .from('test_revision_localizations')
        .select('locale,content_hash')
        .eq('revision_id', current.data.current_revision_id)
    : { data: [], error: null };
  if (published.error) throw published.error;
  const publishedHash = new Map(
    (published.data ?? []).map((row) => [row.locale as AppLocale, row.content_hash]),
  );

  return payload.localizations.map((row) => ({
    locale: row.locale,
    status: publishedStatus(row.status, row.contentHash, publishedHash.get(row.locale)),
    title: row.title,
    description: row.description,
    content: row.content,
    assessment: row.assessment,
    seo: normalizedSeo(row.seo, row.title, row.description),
    sources: normalizedSources(row.sources),
    contentHash: row.contentHash,
    reviewedContentHash: row.reviewedContentHash,
    assessmentImported: row.translationQa.assessmentImported === true,
    draftVersion: row.draftVersion,
    presentation: row.presentation as AdminLocalizedPresentation | null,
  }));
}

async function courseLocalizationSource(courseId: string, locale: AppLocale) {
  const admin = createAdminClient();
  const localization = await admin
    .from('course_draft_localizations')
    .select('translation_qa,draft_version')
    .eq('test_id', courseId)
    .eq('locale', locale)
    .maybeSingle();
  if (localization.error) throw localization.error;
  return {
    translationQa: (localization.data?.translation_qa ?? {}) as RawRecord,
    draftVersion: localization.data?.draft_version ?? null,
  };
}

async function persistCourseLocalization(
  actorId: string,
  courseId: string,
  input: CourseLocalizationDraftInput,
  reviewedHash: string | null,
  expectedVersion: number | null,
  translationQa: RawRecord,
) {
  const result = mutationResultSchema.parse(
    await authenticatedRpc('save_course_localization_draft', {
      p_actor_id: actorId,
      p_test_id: courseId,
      p_locale: input.locale,
      p_expected_version: expectedVersion,
      p_title: input.title,
      p_description: input.description,
      p_content: input.content as Json,
      // An empty array is the explicit browser contract. The RPC preserves
      // the server-held assessment topology; no stable variant/question/
      // option identifiers or answer data cross the Server/Client boundary.
      p_question_variants: [],
      p_seo: input.seo as unknown as Json,
      p_sources: input.sources as unknown as Json,
      p_reviewed_content_hash: reviewedHash,
      p_translation_qa: translationQa as Json,
      p_presentation_id: input.presentationId,
    }),
  );
  return result;
}

export async function saveCourseLocalization(
  courseId: string,
  input: CourseLocalizationDraftInput,
) {
  const actor = await requireCapability('test.manage');
  const source = await courseLocalizationSource(courseId, input.locale);
  if (source.draftVersion !== input.expectedVersion) {
    throw new Error('COURSE_LOCALIZATION_CONFLICT');
  }
  const assessmentImported = source.translationQa.assessmentImported === true;
  if (input.complete && !assessmentImported) {
    throw new Error('COURSE_LOCALIZATION_ASSESSMENT_REQUIRED');
  }
  const qa: RawRecord = {
    ...source.translationQa,
    locale: input.locale,
    mode: 'admin-editor',
    status: input.complete ? 'passed' : 'draft',
    assessmentImported,
  };
  const draft = await persistCourseLocalization(
    actor.user.id,
    courseId,
    input,
    null,
    input.expectedVersion,
    qa,
  );
  const result = input.complete
    ? await persistCourseLocalization(
        actor.user.id,
        courseId,
        input,
        draft.contentHash,
        draft.draftVersion,
        qa,
      )
    : draft;
  return {
    locale: result.locale,
    status: result.status,
    draftVersion: result.draftVersion,
    contentHash: result.contentHash,
  };
}

export async function publishCourseLocalizations(courseId: string, expectedContentHash: string) {
  const actor = await requireCapability('test.manage');
  const result = (await authenticatedRpc('publish_course_revision_v4', {
    p_actor_id: actor.user.id,
    p_test_id: courseId,
    p_expected_content_hash: expectedContentHash,
  })) as RawRecord;
  const revisionId = uuidSchema.parse(result.revisionId);
  const slug = typeof result.slug === 'string' ? result.slug : null;
  invalidateLocalizedContent('course', slug);
  return { revisionId, locales: [...ADMIN_CONTENT_LOCALES] };
}

export async function getArticleEditorLocalizations(
  articleId: string,
): Promise<ArticleLocalizationEditorItem[]> {
  const actor = await requireCapability('content.manage');
  const payload = editorEnvelopeSchema(articleEditorRowSchema, 'articleId').parse(
    await authenticatedRpc('get_article_editor_localizations', {
      p_actor_id: actor.user.id,
      p_article_id: articleId,
    }),
  ) as { articleId: string; localizations: z.infer<typeof articleEditorRowSchema>[] };

  const admin = createAdminClient();
  const current = await admin
    .from('articles')
    .select('current_revision_id')
    .eq('id', articleId)
    .maybeSingle();
  if (current.error) throw current.error;
  const published = current.data?.current_revision_id
    ? await admin
        .from('article_revision_localizations')
        .select('locale,content_hash')
        .eq('revision_id', current.data.current_revision_id)
    : { data: [], error: null };
  if (published.error) throw published.error;
  const publishedHash = new Map(
    (published.data ?? []).map((row) => [row.locale as AppLocale, row.content_hash]),
  );

  return payload.localizations.map((row) => {
    const blocks = articleBlocksSchema.safeParse(row.blocks);
    return {
      locale: row.locale,
      status: publishedStatus(row.status, row.contentHash, publishedHash.get(row.locale)),
      title: row.title,
      description: row.description,
      blocks: blocks.success ? blocks.data : [],
      seo: normalizedSeo(row.seo, row.title, row.description),
      sources: normalizedSources(row.sources),
      contentHash: row.contentHash,
      reviewedContentHash: row.reviewedContentHash,
      draftVersion: row.draftVersion,
    };
  });
}

async function persistArticleLocalization(
  actorId: string,
  articleId: string,
  input: ArticleLocalizationDraftInput,
  reviewedHash: string | null,
  expectedVersion: number | null,
) {
  return mutationResultSchema.parse(
    await authenticatedRpc('save_article_localization_draft', {
      p_actor_id: actorId,
      p_article_id: articleId,
      p_locale: input.locale,
      p_expected_version: expectedVersion,
      p_title: input.title,
      p_description: input.description,
      p_blocks: input.blocks as unknown as Json,
      p_seo: input.seo as unknown as Json,
      p_sources: input.sources as unknown as Json,
      p_reviewed_content_hash: reviewedHash,
      p_translation_qa: {
        locale: input.locale,
        mode: 'admin-editor',
        status: input.complete ? 'passed' : 'draft',
      } as Json,
    }),
  );
}

export async function saveArticleLocalization(
  articleId: string,
  input: ArticleLocalizationDraftInput,
) {
  const actor = await requireCapability('content.manage');
  const draft = await persistArticleLocalization(
    actor.user.id,
    articleId,
    input,
    null,
    input.expectedVersion,
  );
  const result = input.complete
    ? await persistArticleLocalization(
        actor.user.id,
        articleId,
        input,
        draft.contentHash,
        draft.draftVersion,
      )
    : draft;
  return {
    locale: result.locale,
    status: result.status,
    draftVersion: result.draftVersion,
    contentHash: result.contentHash,
  };
}

export async function publishArticleLocalizations(articleId: string, expectedContentHash: string) {
  const actor = await requireCapability('content.manage');
  const result = (await authenticatedRpc('publish_article_revision_v3', {
    p_actor_id: actor.user.id,
    p_article_id: articleId,
    p_expected_content_hash: expectedContentHash,
  })) as RawRecord;
  const revisionId = uuidSchema.parse(result.revisionId);
  const slug = typeof result.slug === 'string' ? result.slug : null;
  invalidateLocalizedContent('article', slug);
  return { revisionId, locales: [...ADMIN_CONTENT_LOCALES] };
}

export async function listLegalLocalizationVersions(): Promise<LegalLocalizationVersion[]> {
  await requireCapability('content.manage');
  const admin = createAdminClient();
  const versions = await admin
    .from('legal_document_versions')
    .select('document_type,version,body_revision,effective_at,is_current')
    .order('effective_at', { ascending: false })
    .limit(50);
  if (versions.error) throw versions.error;
  const selectedVersions = [...new Set((versions.data ?? []).map((item) => item.version))];
  const localizations =
    selectedVersions.length > 0
      ? await admin
          .from('legal_document_localizations')
          .select('document_type,version,locale,title,body,body_hash,status')
          .in('version', selectedVersions)
          .order('document_type', { ascending: true })
          .order('version', { ascending: true })
          .order('locale', { ascending: true })
          .limit(400)
      : { data: [], error: null };
  if (localizations.error) throw localizations.error;
  const byKey = new Map(
    (localizations.data ?? []).map((row) => [
      `${row.document_type}:${row.version}:${row.locale}`,
      row,
    ]),
  );
  return (versions.data ?? []).flatMap((version) => {
    if (version.document_type !== 'privacy' && version.document_type !== 'terms') return [];
    return [
      {
        documentType: version.document_type,
        version: version.version,
        bodyRevision: version.body_revision,
        effectiveAt: version.effective_at,
        current: version.is_current,
        localizations: ADMIN_CONTENT_LOCALES.map((locale) => {
          const row = byKey.get(`${version.document_type}:${version.version}:${locale}`);
          return {
            locale,
            status: (row?.status ?? 'missing') as AdminLocalizationStatus,
            title: row?.title ?? '',
            body:
              row?.body && typeof row.body === 'object' && !Array.isArray(row.body)
                ? (row.body as Record<string, unknown>)
                : {},
            bodyHash: row?.body_hash ?? null,
            immutable: row?.status === 'published',
          };
        }),
      },
    ];
  });
}

export async function stageLegalLocalizationVersion(
  input: LegalVersionStageInput,
): Promise<LegalLocalizationVersion> {
  await requireCapability('content.manage');
  const result = z
    .object({
      documentType: z.enum(['privacy', 'terms']),
      version: z.string().min(1).max(32),
      bodyRevision: z.string().min(3).max(160),
      effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      status: z.literal('draft'),
    })
    .strict()
    .parse(
      await authenticatedRpc('stage_legal_document_version', {
        p_document_type: input.documentType,
        p_version: input.version,
        p_body_revision: input.bodyRevision,
        p_effective_at: input.effectiveAt,
      }),
    );
  revalidatePath('/admin/settings/legal');
  return {
    documentType: result.documentType,
    version: result.version,
    bodyRevision: result.bodyRevision,
    effectiveAt: result.effectiveAt,
    current: false,
    localizations: ADMIN_CONTENT_LOCALES.map((locale) => ({
      locale,
      status: 'missing',
      title: '',
      body: {},
      bodyHash: null,
      immutable: false,
    })),
  };
}

export async function saveLegalLocalization(input: LegalLocalizationDraftInput) {
  await requireCapability('content.manage');
  const result = (await authenticatedRpc('save_legal_document_localization', {
    p_document_type: input.documentType,
    p_version: input.version,
    p_locale: input.locale,
    p_title: input.title,
    p_body: input.body as Json,
    // The forward migration computes the canonical PostgreSQL jsonb digest;
    // callers never attempt to duplicate jsonb serialization rules.
    p_body_hash: null,
    p_complete: input.complete,
  })) as RawRecord;
  return {
    locale: z.enum(ADMIN_CONTENT_LOCALES).parse(result.locale),
    status: z.enum(['draft', 'complete', 'published']).parse(result.status),
    bodyHash: hashSchema.parse(result.bodyHash),
  };
}

const legalBundlePublicationResultSchema = z
  .object({
    privacy: z
      .object({
        version: z.string().min(1).max(32),
        bodyRevision: z.string().min(3).max(160),
        effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      })
      .strict(),
    terms: z
      .object({
        version: z.string().min(1).max(32),
        bodyRevision: z.string().min(3).max(160),
        effectiveAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
      })
      .strict(),
    locales: z.array(z.enum(ADMIN_CONTENT_LOCALES)).length(4),
    replayed: z.boolean(),
  })
  .strict();

export async function publishLegalLocalizationBundle(privacyVersion: string, termsVersion: string) {
  await requireCapability('content.manage');
  const result = legalBundlePublicationResultSchema.parse(
    await authenticatedRpc('publish_legal_document_bundle', {
      p_privacy_version: privacyVersion,
      p_terms_version: termsVersion,
    }),
  );
  revalidatePath('/admin/settings/legal');
  revalidatePath('/privacy');
  revalidatePath('/terms');
  for (const locale of ADMIN_CONTENT_LOCALES.filter((item) => item !== 'ru')) {
    revalidatePath(`/${locale}/privacy`);
    revalidatePath(`/${locale}/terms`);
  }
  return {
    privacy: result.privacy,
    terms: result.terms,
    locales: [...ADMIN_CONTENT_LOCALES],
    replayed: result.replayed,
  };
}
