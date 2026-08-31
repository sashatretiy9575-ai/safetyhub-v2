import 'server-only';

import { z } from 'zod';
import {
  certificateDownloadPayloadSchema,
  getCertificateVerificationToken,
  type CertificateDownloadPayload,
} from '@/features/certificates/server';
import { certificateVerificationUrl } from '@/lib/certificates/verification';
import {
  certificateFilename,
  certificatePdfFingerprint,
  generateCertificateCached,
  type CertificatePayload,
} from '@/lib/pdf/certificate';
import { createStreamingZipArchive, type ArchiveEntry } from '@/lib/pdf/certificate-archive';
import { generateCertificateReport, type CertificateReportRow } from '@/lib/pdf/certificate-report';

export const certificateExportResultSchema = z.object({
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
  requested: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  eligible: z.number().int().nonnegative().max(500),
});

export type CertificateExportResult = z.infer<typeof certificateExportResultSchema>;

export function certificateExportFilename(now: Date) {
  return `safetyhub-certificates-${now.toISOString().slice(0, 10)}.zip`;
}

async function certificatePayload(item: CertificateDownloadPayload, siteUrl: string) {
  const token = await getCertificateVerificationToken(item.id);
  return {
    fullName: item.fullName,
    position: item.job,
    organization: item.organization,
    score: item.score,
    total: item.total,
    passScore: item.passScore,
    certificateNumber: item.certificateNumber,
    issuedAt: new Date(item.issuedAt),
    testTitle: item.testTitle,
    verificationUrl: certificateVerificationUrl(siteUrl, token),
  } satisfies CertificatePayload;
}

function reportRows(items: readonly CertificateDownloadPayload[]): CertificateReportRow[] {
  return items.map((item) => ({
    fullName: item.fullName,
    position: item.job,
    organization: item.organization,
    courseTitle: item.testTitle,
    score: item.score,
    total: item.total,
    completedAt: new Date(item.bestCompletedAt),
    issuedAt: new Date(item.issuedAt),
    certificateNumber: item.certificateNumber,
  }));
}

async function* archiveEntries(
  items: readonly CertificateDownloadPayload[],
  now: Date,
  siteUrl: string,
): AsyncGenerator<ArchiveEntry> {
  yield { name: 'report.pdf', bytes: await generateCertificateReport(reportRows(items), now) };
  for (let offset = 0; offset < items.length; offset += 4) {
    const batch = items.slice(offset, offset + 4);
    const generated = await Promise.all(
      batch.map(async (item) => {
        const payload = await certificatePayload(item, siteUrl);
        const bytes = await generateCertificateCached(
          payload,
          certificatePdfFingerprint(item.id, payload, item.templateVersion),
        );
        return { item, bytes };
      }),
    );
    for (const { item, bytes } of generated) {
      yield {
        name: `certificates/${certificateFilename(item.certificateNumber, item.fullName)}`,
        bytes,
      };
    }
  }
}

export function createCertificateExportStream(
  result: CertificateExportResult,
  now: Date,
  siteUrl: string,
) {
  return createStreamingZipArchive(archiveEntries(result.items, now, siteUrl));
}
