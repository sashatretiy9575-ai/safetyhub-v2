import type { CertificateLocale } from './certificate-client-contract.ts';

export type CertificatePayload = Readonly<{
  fullName: string;
  position: string | null;
  organization: string | null;
  score: number;
  total: number;
  passScore: number;
  certificateNumber: string;
  issuedAt: Date;
  testTitle: string;
  verificationUrl: string;
  locale?: CertificateLocale;
  templateVersion?: number;
}>;

export function normalizePdfText(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function truncateCodePoints(value: string, maxLength: number) {
  const points = Array.from(value);
  if (points.length <= maxLength) return value;
  return `${points.slice(0, Math.max(1, maxLength - 1)).join('')}…`;
}

export function safeFilenameSegment(value: string, maxLength = 80): string {
  const normalized = normalizePdfText(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '')
    .replace(/[. ]+$/gu, '')
    .replace(/\s+/gu, '-');
  return truncateCodePoints(normalized || 'document', maxLength);
}

export function certificateFilename(certificateNumber: string, fullName: string): string {
  return `${safeFilenameSegment(certificateNumber, 48)}-${safeFilenameSegment(fullName, 72)}.pdf`;
}

