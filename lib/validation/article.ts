import { z } from 'zod';
import { contentMetadataDraftSchema } from '../content/content-metadata.ts';

export const ARTICLE_LIMITS = {
  maxBlocks: 100,
  maxPayloadBytes: 128 * 1024,
  maxTextCharacters: 50_000,
} as const;

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const localImagePath = /^\/images\/[a-zA-Z0-9/_-]+\.(?:avif|gif|jpe?g|png|webp)$/i;
const managedContentAssetPath =
  /^\/api\/content-assets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const encodedTraversal = /%(?:2e|2f|5c)/i;

/** Canonical editor value for a WhatsApp CTA resolved from global site settings at render time. */
export const ARTICLE_WHATSAPP_ACTION_URL = '/contacts?channel=whatsapp';

export function isSafeArticleImageUrl(value: string): boolean {
  if (
    value === '/images/blog/placeholder.jpg' ||
    value.length > 2_048 ||
    controlCharacters.test(value) ||
    value.includes('\\') ||
    value.includes('..') ||
    encodedTraversal.test(value)
  ) {
    return false;
  }

  return localImagePath.test(value) || managedContentAssetPath.test(value);
}

export function isSafeArticleButtonUrl(value: string): boolean {
  if (
    value.length > 2_048 ||
    controlCharacters.test(value) ||
    value.includes('\\') ||
    value.includes('..') ||
    encodedTraversal.test(value)
  ) {
    return false;
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    try {
      const base = new URL('https://safetyhub.kz');
      return new URL(value, base).origin === base.origin;
    } catch {
      return false;
    }
  }

  try {
    const url = new URL(value);
    const safeBase =
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /^[a-zA-Z0-9/_?&=#.%+~-]*$/.test(`${url.pathname}${url.search}${url.hash}`);
    if (!safeBase) return false;
    const hostname = url.hostname.toLowerCase();
    return hostname === 'safetyhub.kz' || hostname === 'www.safetyhub.kz';
  } catch {
    return false;
  }
}

export function isSafeArticleSourceUrl(value: string): boolean {
  if (
    value.length > 2_048 ||
    controlCharacters.test(value) ||
    value.includes('\\') ||
    encodedTraversal.test(value)
  ) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      Boolean(url.hostname) &&
      url.hostname.toLowerCase() !== 'wa.me'
    );
  } catch {
    return false;
  }
}

const articleImageUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isSafeArticleImageUrl, 'ARTICLE_IMAGE_URL_INVALID');

export const articleCoverImageSchema = z.preprocess(
  (value) => (value == null || value === '/images/blog/placeholder.jpg' ? '' : value),
  z.union([z.literal(''), articleImageUrlSchema]),
);

const articleSeoSchema = z
  .object({
    title: z.string().trim().min(3).max(70),
    description: z.string().trim().min(40).max(200),
    ogTitle: z.string().trim().min(3).max(70),
    ogDescription: z.string().trim().min(40).max(200),
    ogImage: articleCoverImageSchema,
    indexable: z.boolean(),
  })
  .strict();

const articleButtonUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isSafeArticleButtonUrl, 'ARTICLE_BUTTON_URL_INVALID');

const articleSourceUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .refine(isSafeArticleSourceUrl, 'ARTICLE_SOURCE_URL_INVALID');

const optionalShortText = z.string().trim().max(240).optional();

const accessibleImageFields = {
  src: articleImageUrlSchema,
  alt: z.string().trim().max(240),
  decorative: z.boolean(),
  caption: optionalShortText,
} as const;

const accessibleImageSchema = z
  .object(accessibleImageFields)
  .strict()
  .superRefine((image, context) => {
    if (image.decorative && image.alt.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'DECORATIVE_IMAGE_ALT_MUST_BE_EMPTY',
      });
    }
    if (!image.decorative && image.alt.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'MEANINGFUL_IMAGE_ALT_REQUIRED',
      });
    }
  });

function normalizeLegacyImage(value: unknown): unknown {
  if (typeof value === 'string') {
    return { src: value, alt: '', decorative: true };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const image = value as Record<string, unknown>;
  if (typeof image.decorative === 'boolean') return value;
  const alt = typeof image.alt === 'string' ? image.alt : '';
  return { ...image, alt, decorative: alt.trim().length === 0 };
}

function normalizeLegacyBlock(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const block = value as Record<string, unknown>;
  if (block.type === 'image') return normalizeLegacyImage(block);
  if (block.type === 'slider' && Array.isArray(block.images)) {
    return { ...block, images: block.images.map(normalizeLegacyImage) };
  }
  return value;
}

const paragraphBlockSchema = z
  .object({
    type: z.literal('paragraph'),
    content: z.string().trim().min(1).max(5_000),
  })
  .strict();

const headingBlockSchema = z
  .object({
    type: z.literal('heading'),
    content: z.string().trim().min(1).max(180),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  })
  .strict();

const imageBlockSchema = z
  .object({
    type: z.literal('image'),
    ...accessibleImageFields,
  })
  .strict()
  .superRefine((image, context) => {
    if (image.decorative && image.alt.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'DECORATIVE_IMAGE_ALT_MUST_BE_EMPTY',
      });
    }
    if (!image.decorative && image.alt.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['alt'],
        message: 'MEANINGFUL_IMAGE_ALT_REQUIRED',
      });
    }
  });

const buttonBlockSchema = z
  .object({
    type: z.literal('button'),
    text: z.string().trim().min(1).max(80),
    url: articleButtonUrlSchema,
    style: z.enum(['primary', 'outline']),
  })
  .strict();

const sliderBlockSchema = z
  .object({
    type: z.literal('slider'),
    label: z.string().trim().min(1).max(120).optional(),
    images: z.array(accessibleImageSchema).min(1).max(10),
  })
  .strict();

const quoteBlockSchema = z
  .object({
    type: z.literal('quote'),
    content: z.string().trim().min(1).max(2_000),
  })
  .strict();

const listBlockSchema = z
  .object({
    type: z.literal('list'),
    style: z.enum(['unordered', 'ordered']),
    items: z.array(z.string().trim().min(1).max(1_000)).min(1).max(50),
  })
  .strict();

const tableBlockSchema = z
  .object({
    type: z.literal('table'),
    caption: z.string().trim().min(1).max(240).optional(),
    headers: z.array(z.string().trim().min(1).max(240)).min(1).max(12),
    rows: z
      .array(z.array(z.string().trim().max(1_000)).min(1).max(12))
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((table, context) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.headers.length) {
        context.addIssue({
          code: 'custom',
          path: ['rows', index],
          message: 'ARTICLE_TABLE_COLUMN_COUNT_MISMATCH',
        });
      }
    });
  });

const calloutBlockSchema = z
  .object({
    type: z.literal('callout'),
    tone: z.enum(['info', 'warning', 'success']),
    title: z.string().trim().min(1).max(180).optional(),
    content: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const articleSourceSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    url: articleSourceUrlSchema,
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const sourceBlockSchema = articleSourceSchema.extend({ type: z.literal('source') }).strict();
const dividerBlockSchema = z.object({ type: z.literal('divider') }).strict();

const articleBlockUnionSchema = z.discriminatedUnion('type', [
  paragraphBlockSchema,
  headingBlockSchema,
  imageBlockSchema,
  buttonBlockSchema,
  sliderBlockSchema,
  quoteBlockSchema,
  listBlockSchema,
  tableBlockSchema,
  calloutBlockSchema,
  sourceBlockSchema,
  dividerBlockSchema,
]);

export const articleBlockSchema = z.preprocess(normalizeLegacyBlock, articleBlockUnionSchema);

export const articleBlocksSchema = z
  .array(articleBlockSchema)
  .max(ARTICLE_LIMITS.maxBlocks)
  .superRefine((blocks, context) => {
    if (blockTextCharacters(blocks) > ARTICLE_LIMITS.maxTextCharacters) {
      context.addIssue({ code: 'custom', message: 'ARTICLE_TEXT_TOO_LARGE' });
    }
  });

export const articleStatusSchema = z.enum(['draft', 'published']);

const articleDateSchema = z.string().trim().min(1).max(40);

export const articleDocumentSchema = z
  .object({
    slug: slugSchema,
    title: z.string().trim().min(2).max(180),
    description: z.string().trim().max(500).default(''),
    coverImage: articleCoverImageSchema,
    createdAt: articleDateSchema.optional(),
    updatedAt: articleDateSchema.optional(),
    publishedAt: articleDateSchema.nullable().optional(),
    author: z.string().trim().min(1).max(180).optional(),
    seo: articleSeoSchema.optional(),
    ...contentMetadataDraftSchema.shape,
    blocks: articleBlocksSchema,
  })
  .strict();

export const articleDocumentMetadataSchema = articleDocumentSchema.omit({ blocks: true });

function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function blockTextCharacters(blocks: z.infer<typeof articleBlockSchema>[]): number {
  return blocks.reduce((total, block) => {
    if (
      block.type === 'paragraph' ||
      block.type === 'heading' ||
      block.type === 'quote' ||
      block.type === 'callout'
    ) {
      return (
        total + block.content.length + (block.type === 'callout' ? (block.title?.length ?? 0) : 0)
      );
    }
    if (block.type === 'button') return total + block.text.length;
    if (block.type === 'image') return total + block.alt.length + (block.caption?.length ?? 0);
    if (block.type === 'slider') {
      return (
        total +
        block.images.reduce(
          (imageTotal, image) => imageTotal + image.alt.length + (image.caption?.length ?? 0),
          0,
        )
      );
    }
    if (block.type === 'list') {
      return total + block.items.reduce((itemTotal, item) => itemTotal + item.length, 0);
    }
    if (block.type === 'table') {
      return (
        total +
        (block.caption?.length ?? 0) +
        block.headers.reduce((cellTotal, cell) => cellTotal + cell.length, 0) +
        block.rows.flat().reduce((cellTotal, cell) => cellTotal + cell.length, 0)
      );
    }
    if (block.type === 'source') {
      return total + block.title.length + (block.note?.length ?? 0);
    }
    return total;
  }, 0);
}

export const articleDraftInputSchema = z
  .object({
    id: z.uuid().nullable().optional(),
    originalSlug: slugSchema.nullable().optional(),
    draftVersion: z.number().int().positive().optional(),
    slug: slugSchema,
    title: z.string().trim().min(2).max(180),
    description: z.string().trim().max(500),
    coverImage: articleCoverImageSchema,
    seo: articleSeoSchema.optional(),
    ...contentMetadataDraftSchema.shape,
    blocks: articleBlocksSchema,
  })
  .strict()
  .superRefine((article, context) => {
    if (Boolean(article.id) !== Boolean(article.originalSlug)) {
      context.addIssue({
        code: 'custom',
        path: ['originalSlug'],
        message: 'ARTICLE_IDENTITY_INCOMPLETE',
      });
    }
    if (serializedBytes(article) > ARTICLE_LIMITS.maxPayloadBytes) {
      context.addIssue({ code: 'custom', path: ['blocks'], message: 'ARTICLE_PAYLOAD_TOO_LARGE' });
    }
  });

export const articleStatusInputSchema = z
  .object({
    articleId: z.uuid(),
    status: articleStatusSchema,
    expectedContentHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.status === 'published' && !input.expectedContentHash) {
      context.addIssue({
        code: 'custom',
        path: ['expectedContentHash'],
        message: 'ARTICLE_CONTENT_HASH_REQUIRED',
      });
    }
  });

export const articleDeleteInputSchema = z
  .object({
    articleId: z.uuid(),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export type ArticleAccessibleImage = z.infer<typeof accessibleImageSchema>;
export type ArticleBlockInput = z.infer<typeof articleBlockSchema>;
export type ArticleDocumentInput = z.infer<typeof articleDocumentSchema>;
export type ArticleSourceInput = z.infer<typeof articleSourceSchema>;
export type ArticleDraftInput = z.infer<typeof articleDraftInputSchema>;
export type ArticleLifecycleStatus = z.infer<typeof articleStatusSchema>;
