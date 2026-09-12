import * as z from 'zod/mini';
import { contentMetadataDraftSchema } from '../content/content-metadata.ts';
import { isSafeSourceUrl } from './source-url.ts';

// zod/mini on purpose: the article editor, the course editor and the public
// article renderer all validate blocks in the browser, and the classic API
// would ship every locale and the JSON-Schema compiler with them.

export const ARTICLE_LIMITS = {
  maxBlocks: 100,
  maxPayloadBytes: 128 * 1024,
  maxTextCharacters: 50_000,
} as const;

const slugSchema = z
  .string()
  .check(z.trim(), z.minLength(1), z.maxLength(120), z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/));

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

/**
 * An article block links out of running prose, so it is stricter than a
 * bibliography entry: no encoded traversal, no explicit port, and no `wa.me`
 * link, because a WhatsApp call to action must resolve from the current global
 * contacts instead of being frozen into the document.
 */
export function isSafeArticleSourceUrl(value: string): boolean {
  if (!isSafeSourceUrl(value) || encodedTraversal.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.port && url.hostname.toLowerCase() !== 'wa.me';
  } catch {
    return false;
  }
}

function trimmedText(min: number, max: number) {
  return z.string().check(z.trim(), z.minLength(min), z.maxLength(max));
}

const articleImageUrlSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1),
    z.maxLength(2_048),
    z.refine(isSafeArticleImageUrl, 'ARTICLE_IMAGE_URL_INVALID'),
  );

export const articleCoverImageSchema = z.pipe(
  z.transform((value: unknown) =>
    value == null || value === '/images/blog/placeholder.jpg' ? '' : value,
  ),
  z.union([z.literal(''), articleImageUrlSchema]),
);

const articleSeoSchema = z.strictObject({
  title: trimmedText(3, 70),
  description: trimmedText(40, 200),
  ogTitle: trimmedText(3, 70),
  ogDescription: trimmedText(40, 200),
  ogImage: articleCoverImageSchema,
  indexable: z.boolean(),
});

const articleButtonUrlSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1),
    z.maxLength(2_048),
    z.refine(isSafeArticleButtonUrl, 'ARTICLE_BUTTON_URL_INVALID'),
  );

const articleSourceUrlSchema = z
  .string()
  .check(
    z.trim(),
    z.minLength(1),
    z.maxLength(2_048),
    z.refine(isSafeArticleSourceUrl, 'ARTICLE_SOURCE_URL_INVALID'),
  );

const optionalShortText = z.optional(z.string().check(z.trim(), z.maxLength(240)));

const accessibleImageFields = {
  src: articleImageUrlSchema,
  alt: z.string().check(z.trim(), z.maxLength(240)),
  decorative: z.boolean(),
  caption: optionalShortText,
} as const;

const accessibleImageAltMatchesRole = z.superRefine(
  (image: { alt: string; decorative: boolean }, context) => {
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
  },
);

const accessibleImageSchema = z
  .strictObject(accessibleImageFields)
  .check(accessibleImageAltMatchesRole);

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

const paragraphBlockSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: trimmedText(1, 5_000),
});

const headingBlockSchema = z.strictObject({
  type: z.literal('heading'),
  content: trimmedText(1, 180),
  level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
});

const imageBlockSchema = z
  .strictObject({
    type: z.literal('image'),
    ...accessibleImageFields,
  })
  .check(accessibleImageAltMatchesRole);

const buttonBlockSchema = z.strictObject({
  type: z.literal('button'),
  text: trimmedText(1, 80),
  url: articleButtonUrlSchema,
  style: z.enum(['primary', 'outline']),
});

const sliderBlockSchema = z.strictObject({
  type: z.literal('slider'),
  label: z.optional(trimmedText(1, 120)),
  images: z.array(accessibleImageSchema).check(z.minLength(1), z.maxLength(10)),
});

const quoteBlockSchema = z.strictObject({
  type: z.literal('quote'),
  content: trimmedText(1, 2_000),
});

const listBlockSchema = z.strictObject({
  type: z.literal('list'),
  style: z.enum(['unordered', 'ordered']),
  items: z.array(trimmedText(1, 1_000)).check(z.minLength(1), z.maxLength(50)),
});

const tableBlockSchema = z
  .strictObject({
    type: z.literal('table'),
    caption: z.optional(trimmedText(1, 240)),
    headers: z.array(trimmedText(1, 240)).check(z.minLength(1), z.maxLength(12)),
    rows: z
      .array(
        z
          .array(z.string().check(z.trim(), z.maxLength(1_000)))
          .check(z.minLength(1), z.maxLength(12)),
      )
      .check(z.minLength(1), z.maxLength(100)),
  })
  .check(
    z.superRefine((table, context) => {
      table.rows.forEach((row, index) => {
        if (row.length !== table.headers.length) {
          context.addIssue({
            code: 'custom',
            path: ['rows', index],
            message: 'ARTICLE_TABLE_COLUMN_COUNT_MISMATCH',
          });
        }
      });
    }),
  );

const calloutBlockSchema = z.strictObject({
  type: z.literal('callout'),
  tone: z.enum(['info', 'warning', 'success']),
  title: z.optional(trimmedText(1, 180)),
  content: trimmedText(1, 2_000),
});

export const articleSourceSchema = z.strictObject({
  title: trimmedText(1, 240),
  url: articleSourceUrlSchema,
  note: z.optional(trimmedText(1, 500)),
});

const sourceBlockSchema = z.extend(articleSourceSchema, { type: z.literal('source') });
const dividerBlockSchema = z.strictObject({ type: z.literal('divider') });

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

// Legacy rows are reshaped before validation; the union still decides what is valid.
export const articleBlockSchema = z.pipe(
  z.transform((value: unknown) => normalizeLegacyBlock(value)),
  articleBlockUnionSchema,
);

export const articleBlocksSchema = z.array(articleBlockSchema).check(
  z.maxLength(ARTICLE_LIMITS.maxBlocks),
  z.superRefine((blocks, context) => {
    if (blockTextCharacters(blocks) > ARTICLE_LIMITS.maxTextCharacters) {
      context.addIssue({ code: 'custom', message: 'ARTICLE_TEXT_TOO_LARGE' });
    }
  }),
);

/**
 * The same blocks, plus the rule that heading levels may not skip.
 *
 * The editor offers H2, H3 and H4 as three independent choices, so an article
 * could be published whose first heading is an H4, or which drops from H2
 * straight to H4. A reader navigating by headings then meets a level with no
 * parent. This is deliberately separate from `articleBlocksSchema`: that one
 * also parses content already in the database, and tightening it there would
 * make an article that was legal when it was saved unreadable now.
 */
export const articleBlocksWriteSchema = articleBlocksSchema.check(
  z.superRefine((blocks, context) => {
    let previous = 1;
    blocks.forEach((block, index) => {
      if (!isHeadingBlock(block)) return;
      if (block.level > previous + 1) {
        context.addIssue({
          code: 'custom',
          path: [index, 'level'],
          message: 'ARTICLE_HEADING_LEVEL_SKIPPED',
        });
      }
      previous = block.level;
    });
  }),
);

function isHeadingBlock(block: unknown): block is { type: 'heading'; level: 2 | 3 | 4 } {
  return (
    typeof block === 'object' &&
    block !== null &&
    (block as { type?: unknown }).type === 'heading' &&
    typeof (block as { level?: unknown }).level === 'number'
  );
}

export const articleStatusSchema = z.enum(['draft', 'published']);

const articleDateSchema = trimmedText(1, 40);

export const articleDocumentSchema = z.strictObject({
  slug: slugSchema,
  title: trimmedText(2, 180),
  description: z._default(z.string().check(z.trim(), z.maxLength(500)), ''),
  coverImage: articleCoverImageSchema,
  createdAt: z.optional(articleDateSchema),
  updatedAt: z.optional(articleDateSchema),
  publishedAt: z.optional(z.nullable(articleDateSchema)),
  author: z.optional(trimmedText(1, 180)),
  seo: z.optional(articleSeoSchema),
  ...contentMetadataDraftSchema.shape,
  blocks: articleBlocksSchema,
});

export const articleDocumentMetadataSchema = z.omit(articleDocumentSchema, { blocks: true });

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
  .strictObject({
    id: z.optional(z.nullable(z.uuid())),
    originalSlug: z.optional(z.nullable(slugSchema)),
    draftVersion: z.optional(z.int().check(z.positive())),
    slug: slugSchema,
    title: trimmedText(2, 180),
    description: z.string().check(z.trim(), z.maxLength(500)),
    coverImage: articleCoverImageSchema,
    seo: z.optional(articleSeoSchema),
    ...contentMetadataDraftSchema.shape,
    blocks: articleBlocksWriteSchema,
  })
  .check(
    z.superRefine((article, context) => {
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
    }),
  );

export const articleStatusInputSchema = z
  .strictObject({
    articleId: z.uuid(),
    status: articleStatusSchema,
    expectedContentHash: z.optional(z.string().check(z.regex(/^[0-9a-f]{64}$/))),
  })
  .check(
    z.superRefine((input, context) => {
      if (input.status === 'published' && !input.expectedContentHash) {
        context.addIssue({
          code: 'custom',
          path: ['expectedContentHash'],
          message: 'ARTICLE_CONTENT_HASH_REQUIRED',
        });
      }
    }),
  );

export const articleDeleteInputSchema = z.strictObject({
  articleId: z.uuid(),
  expectedVersion: z.int().check(z.positive()),
});

export type ArticleAccessibleImage = z.infer<typeof accessibleImageSchema>;
export type ArticleBlockInput = z.infer<typeof articleBlockSchema>;
export type ArticleDocumentInput = z.infer<typeof articleDocumentSchema>;
export type ArticleSourceInput = z.infer<typeof articleSourceSchema>;
export type ArticleDraftInput = z.infer<typeof articleDraftInputSchema>;
export type ArticleLifecycleStatus = z.infer<typeof articleStatusSchema>;
