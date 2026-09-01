import 'server-only';

import { cache } from 'react';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/supabase/types';
import type { AppLocale } from '@/i18n/config';
import type { LegalDocumentType } from '@/lib/legal';

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
              (url) => url.startsWith('https://') || (/^\/(?!\/)/u.test(url) && !url.includes('\\')),
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

export type LocalizedLegalDocument = z.infer<typeof localizedLegalDocumentSchema>;

type LegalRpcClient = {
  rpc(
    name: 'get_legal_document_localization',
    args: {
      p_document_type: LegalDocumentType;
      p_version: string;
      p_locale: AppLocale;
    },
  ): PromiseLike<{ data: Json; error: { message: string } | null }>;
};

export const getLocalizedLegalDocument = cache(
  async (
    documentType: LegalDocumentType,
    version: string | undefined,
    locale: Exclude<AppLocale, 'ru'>,
  ): Promise<LocalizedLegalDocument | null> => {
    try {
      const supabase = (await createClient()) as unknown as LegalRpcClient;
      const { data, error } = await supabase.rpc('get_legal_document_localization', {
        p_document_type: documentType,
        p_version: version ?? '',
        p_locale: locale,
      });
      if (error) return null;
      const parsed = localizedLegalDocumentSchema.safeParse(data);
      if (!parsed.success || parsed.data.type !== documentType || parsed.data.locale !== locale) {
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  },
);
