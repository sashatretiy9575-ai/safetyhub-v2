import 'server-only';

import { z } from 'zod';
import {
  certificateDownloadPayloadSchema,
  createCertificateRenderMetadata,
} from '@/features/certificates/server';
import {
  CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
  CERTIFICATE_CLIENT_SCHEMA_VERSION,
  CERTIFICATE_EXPORT_MAX_ITEMS,
  CERTIFICATE_RENDER_CONCURRENCY,
  type CertificateExportMetadata,
} from '@/lib/pdf/certificate-client-contract';

export const certificateExportResultSchema = z
  .object({
    items: z.array(certificateDownloadPayloadSchema).max(500),
    skipped: z
      .array(
        z.object({
          attestationId: z.string().uuid(),
          reason: z
            .string()
            .max(96)
            .regex(/^[A-Za-z][A-Za-z0-9_]{1,95}(?::[0-9]{1,10})?$/u),
        }),
      )
      .max(500),
    requested: z.number().int().nonnegative().max(500),
    total: z.number().int().nonnegative().max(500),
    eligible: z.number().int().nonnegative().max(500),
  })
  .superRefine((value, context) => {
    if (
      value.total !== value.requested ||
      value.items.length !== value.eligible ||
      value.items.length + value.skipped.length !== value.requested
    ) {
      context.addIssue({ code: 'custom', message: 'CERTIFICATE_EXPORT_COUNT_INVALID' });
    }
  });

export type CertificateExportResult = z.infer<typeof certificateExportResultSchema>;

export function certificateExportFilename(now: Date) {
  return `safetyhub-certificates-${now.toISOString().slice(0, 10)}.zip`;
}

export async function createCertificateExportMetadata(
  result: CertificateExportResult,
  now: Date,
  siteUrl: string,
): Promise<CertificateExportMetadata> {
  const items = [];
  for (let offset = 0; offset < result.items.length; offset += 25) {
    items.push(
      ...(await Promise.all(
        result.items
          .slice(offset, offset + 25)
          .map((item) => createCertificateRenderMetadata(item, siteUrl)),
      )),
    );
  }
  return {
    schemaVersion: CERTIFICATE_CLIENT_SCHEMA_VERSION,
    filename: certificateExportFilename(now),
    generatedAt: now.toISOString(),
    requested: result.requested,
    total: result.total,
    eligible: items.length,
    reportFontUrl: `/certificate-assets/font?locale=${items.some((item) => item.locale === 'zh') ? 'zh&v=Sans2.004' : 'ru&v=1'}`,
    skipped: result.skipped,
    items,
    archivePolicy: {
      maxItemsPerBufferedArchive: CERTIFICATE_BUFFERED_ARCHIVE_MAX_ITEMS,
      maxItems: CERTIFICATE_EXPORT_MAX_ITEMS,
      renderConcurrency: CERTIFICATE_RENDER_CONCURRENCY,
    },
  };
}
