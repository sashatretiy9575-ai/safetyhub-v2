import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

export type CertificatePayload = {
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
};

const CERTIFICATE_TEMPLATE_PATH = path.join(
  process.cwd(),
  'public',
  'certificates',
  'template-v1.pdf',
);
const CYRILLIC_FONT_PATH = path.join(
  process.cwd(),
  'lib',
  'pdf',
  'assets',
  'noto-sans-latin-cyrillic.ttf',
);

// Template/font bytes are immutable deployment assets. A warm instance reads
// them once; request-specific text and QR bytes never enter this promise.
const CERTIFICATE_STATIC_ASSETS = Promise.all([
  fs.readFile(CERTIFICATE_TEMPLATE_PATH),
  fs.readFile(CYRILLIC_FONT_PATH),
]);

const PDF_CACHE_MAX_ENTRIES = 16;
const PDF_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const PDF_CACHE_TTL_MS = 10 * 60 * 1000;
const pdfCache = new Map<string, { bytes: Uint8Array; expiresAt: number }>();
const pdfInFlight = new Map<string, Promise<Uint8Array>>();
let pdfCacheBytes = 0;

function cachedPdf(fingerprint: string) {
  const entry = pdfCache.get(fingerprint);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    pdfCache.delete(fingerprint);
    pdfCacheBytes -= entry.bytes.byteLength;
    return null;
  }
  pdfCache.delete(fingerprint);
  pdfCache.set(fingerprint, entry);
  return entry.bytes;
}

function storePdf(fingerprint: string, bytes: Uint8Array) {
  const previous = pdfCache.get(fingerprint);
  if (previous) pdfCacheBytes -= previous.bytes.byteLength;
  pdfCache.set(fingerprint, { bytes, expiresAt: Date.now() + PDF_CACHE_TTL_MS });
  pdfCacheBytes += bytes.byteLength;
  while (pdfCache.size > PDF_CACHE_MAX_ENTRIES || pdfCacheBytes > PDF_CACHE_MAX_BYTES) {
    const oldest = pdfCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    const removed = pdfCache.get(oldest);
    pdfCache.delete(oldest);
    if (removed) pdfCacheBytes -= removed.bytes.byteLength;
  }
}

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

function asciiAttachmentFallback(value: string, extension: string) {
  const withoutExtension = value.toLowerCase().endsWith(extension.toLowerCase())
    ? value.slice(0, -extension.length)
    : value;
  const stem = withoutExtension
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96);
  return `${stem || 'download'}${extension}`;
}

function encodeRfc5987(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentContentDisposition(filename: string): string {
  const safeFilename = normalizePdfText(filename).replace(/[\u0000-\u001f\u007f]/gu, '');
  const extension = path.extname(safeFilename).slice(0, 12) || '.bin';
  const fallback = asciiAttachmentFallback(safeFilename, extension);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(safeFilename)}`;
}

export function certificatePdfFingerprint(
  certificateId: string,
  payload: CertificatePayload,
  templateVersion = 1,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        certificateId,
        templateVersion,
        fullName: normalizePdfText(payload.fullName),
        position: payload.position ? normalizePdfText(payload.position) : null,
        organization: payload.organization ? normalizePdfText(payload.organization) : null,
        score: payload.score,
        total: payload.total,
        passScore: payload.passScore,
        certificateNumber: normalizePdfText(payload.certificateNumber),
        issuedAt: payload.issuedAt.toISOString(),
        testTitle: normalizePdfText(payload.testTitle),
        verificationUrl: payload.verificationUrl,
      }),
      'utf8',
    )
    .digest('hex');
}

function fittedTextSize(font: PDFFont, text: string, size: number, maxWidth: number, minSize = 8) {
  const naturalWidth = font.widthOfTextAtSize(text, size);
  if (naturalWidth <= maxWidth) return size;
  return Math.max(minSize, size * (maxWidth / naturalWidth));
}

function wrapLine(font: PDFFont, text: string, size: number, maxWidth: number) {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines;
}

function fittedLines(
  font: PDFFont,
  text: string,
  preferredSize: number,
  maxWidth: number,
  maxLines: number,
  minSize = 8,
) {
  for (let size = preferredSize; size >= minSize; size -= 0.5) {
    const lines = wrapLine(font, text, size, maxWidth);
    if (
      lines.length <= maxLines &&
      lines.every((line) => font.widthOfTextAtSize(line, size) <= maxWidth)
    ) {
      return { lines, size };
    }
  }
  throw new Error('CERTIFICATE_TEXT_DOES_NOT_FIT');
}

function drawCenteredText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  options: {
    y: number;
    size: number;
    maxWidth?: number;
    maxLines?: 1 | 2;
    minSize?: number;
    color?: ReturnType<typeof rgb>;
  },
) {
  const { width } = page.getSize();
  const maxWidth = options.maxWidth ?? width - 72;
  const maxLines = options.maxLines ?? 1;
  const { lines, size } =
    maxLines === 1
      ? { lines: [text], size: fittedTextSize(font, text, options.size, maxWidth, options.minSize) }
      : fittedLines(font, text, options.size, maxWidth, maxLines, options.minSize);
  const lineHeight = size * 1.2;
  const firstY = options.y + ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, index) => {
    const textWidth = font.widthOfTextAtSize(line, size);
    page.drawText(line, {
      x: (width - textWidth) / 2,
      y: firstY - index * lineHeight,
      size,
      font,
      color: options.color ?? rgb(0.06, 0.09, 0.16),
    });
  });
}

export async function generateCertificate(payload: CertificatePayload): Promise<Uint8Array> {
  const normalized = {
    ...payload,
    fullName: normalizePdfText(payload.fullName),
    position: payload.position ? normalizePdfText(payload.position) : null,
    organization: payload.organization ? normalizePdfText(payload.organization) : null,
    certificateNumber: normalizePdfText(payload.certificateNumber),
    testTitle: normalizePdfText(payload.testTitle),
  };
  const [[pdfBytes, fontBytes], qrCodeBytes] = await Promise.all([
    CERTIFICATE_STATIC_ASSETS,
    QRCode.toBuffer(payload.verificationUrl, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 256,
      color: { dark: '#0F172AFF', light: '#FFFFFFFF' },
    }),
  ]);

  const pdfDoc = await PDFDocument.load(pdfBytes);
  pdfDoc.setTitle(`Сертификат ${normalized.certificateNumber}`);
  pdfDoc.setSubject('Проверяемый сертификат SafetyHub.kz');
  pdfDoc.setAuthor('SafetyHub.kz');
  pdfDoc.setCreator('SafetyHub.kz');
  pdfDoc.setProducer('SafetyHub.kz');
  pdfDoc.setCreationDate(normalized.issuedAt);
  pdfDoc.setModificationDate(normalized.issuedAt);
  pdfDoc.registerFontkit(fontkit);
  // This is a build-time Latin/Cyrillic/Kazakh font asset. Runtime subsetting
  // remains disabled because it produced broken glyph maps in some readers.
  const font = await pdfDoc.embedFont(fontBytes, { subset: false });
  const qrCode = await pdfDoc.embedPng(qrCodeBytes);

  const page = pdfDoc.getPages()[0];
  if (!page) throw new Error('EMPTY_CERTIFICATE_TEMPLATE');
  const { width } = page.getSize();
  const ink = rgb(0.06, 0.09, 0.16);
  const muted = rgb(0.35, 0.4, 0.47);
  const green = rgb(0.07, 0.49, 0.16);

  drawCenteredText(page, font, 'СЕРТИФИКАТ', {
    y: 694,
    size: 28,
    color: green,
  });
  drawCenteredText(page, font, 'подтверждает успешное прохождение курса', {
    y: 654,
    size: 12,
    color: muted,
  });
  drawCenteredText(page, font, normalized.testTitle, {
    y: 486,
    size: 21,
    maxWidth: width - 96,
    maxLines: 2,
    minSize: 12,
  });
  drawCenteredText(page, font, normalized.fullName, {
    y: 414,
    size: 31,
    maxWidth: width - 88,
    maxLines: 2,
    minSize: 16,
    color: green,
  });

  if (normalized.position) {
    drawCenteredText(page, font, `Должность: ${normalized.position}`, {
      y: 350,
      size: 13,
      maxWidth: width - 100,
      maxLines: 2,
      minSize: 9,
    });
  }
  if (normalized.organization) {
    drawCenteredText(page, font, `Компания: ${normalized.organization}`, {
      y: 310,
      size: 13,
      maxWidth: width - 100,
      maxLines: 2,
      minSize: 9,
    });
  }

  drawCenteredText(page, font, `Результат: ${normalized.score} из ${normalized.total}`, {
    y: 244,
    size: 18,
    color: green,
  });
  drawCenteredText(page, font, `Проходной балл: ${normalized.passScore} из ${normalized.total}`, {
    y: 216,
    size: 10,
    color: muted,
  });

  page.drawText(`Сертификат № ${normalized.certificateNumber}`, {
    x: 64,
    y: 151,
    size: fittedTextSize(font, `Сертификат № ${normalized.certificateNumber}`, 11, width - 220),
    font,
    color: ink,
  });
  page.drawText(`Дата выдачи: ${normalized.issuedAt.toLocaleDateString('ru-RU')}`, {
    x: 64,
    y: 126,
    size: 10,
    font,
    color: muted,
  });

  const qrSize = 74;
  const qrX = width - qrSize - 64;
  const qrY = 90;
  const qrLabel = 'Проверить подлинность';
  const qrLabelSize = 7;
  page.drawRectangle({
    x: qrX - 7,
    y: qrY - 7,
    width: qrSize + 14,
    height: qrSize + 28,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.79, 0.84, 0.8),
    borderWidth: 0.7,
  });
  page.drawImage(qrCode, { x: qrX, y: qrY, width: qrSize, height: qrSize });
  page.drawText(qrLabel, {
    x: qrX + (qrSize - font.widthOfTextAtSize(qrLabel, qrLabelSize)) / 2,
    y: qrY + qrSize + 7,
    size: qrLabelSize,
    font,
    color: muted,
  });

  return pdfDoc.save({ useObjectStreams: true });
}

export async function generateCertificateCached(
  payload: CertificatePayload,
  immutableFingerprint: string,
) {
  if (!/^[0-9a-f]{64}$/.test(immutableFingerprint)) {
    throw new Error('CERTIFICATE_FINGERPRINT_INVALID');
  }
  const cached = cachedPdf(immutableFingerprint);
  if (cached) return cached;
  const existing = pdfInFlight.get(immutableFingerprint);
  if (existing) return existing;
  const pending = generateCertificate(payload).then((bytes) => {
    storePdf(immutableFingerprint, bytes);
    return bytes;
  });
  pdfInFlight.set(immutableFingerprint, pending);
  try {
    return await pending;
  } finally {
    pdfInFlight.delete(immutableFingerprint);
  }
}
